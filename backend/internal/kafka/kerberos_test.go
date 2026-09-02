package kafka

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"errors"
	"os"
	"strings"
	"testing"

	goforkasn1 "github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/asn1tools"
	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/config"
	gokrb5crypto "github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/errorcode"
	"github.com/jcmturner/gokrb5/v8/iana/etypeID"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/iana/nametype"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/spnego"
	"github.com/jcmturner/gokrb5/v8/types"

	"dataBasePro/backend/internal/model"
)

// scriptedHandshaker replays a pre-programmed GSSAPI token exchange, standing
// in for gokrb5 in the SASL session tests.
type scriptedHandshaker struct {
	initial    []byte
	replies    [][]byte // one reply per Continue call
	establish  []bool   // established flag per Continue call
	finalOK    bool
	calls      []string
	challenges [][]byte
}

func (s *scriptedHandshaker) Initial(_ context.Context) ([]byte, error) {
	s.calls = append(s.calls, "initial")
	return s.initial, nil
}

func (s *scriptedHandshaker) Continue(_ context.Context, challenge []byte) (bool, []byte, error) {
	s.calls = append(s.calls, "continue")
	s.challenges = append(s.challenges, challenge)
	i := len(s.calls) - 2 // minus the initial call
	if i >= len(s.replies) {
		return false, nil, errors.New("script exhausted")
	}
	return s.establish[i], s.replies[i], nil
}

func (s *scriptedHandshaker) Final(_ context.Context, challenge []byte) error {
	s.calls = append(s.calls, "final")
	s.challenges = append(s.challenges, challenge)
	if !s.finalOK {
		return errors.New("bad final token")
	}
	return nil
}

func kerberosTestConfig() model.SASLConfig {
	return model.SASLConfig{
		Enabled:      true,
		Mechanism:    model.SaslGssapi,
		Principal:    "admin/admin@YHSJ.COM",
		KeytabPath:   "/etc/security/keytabs/admin.keytab",
		Krb5ConfPath: "/etc/krb5.conf",
		ServiceName:  "kafka",
	}
}

// The full SASL session flow over a scripted handshake: initial token comes
// back from Authenticate, continue replies flow through Challenge, and the
// server's final token is validated via Final before reporting done.
func TestKerberosSessionFlow(t *testing.T) {
	hs := &scriptedHandshaker{
		initial:   []byte("init-token"),
		replies:   [][]byte{[]byte("reply-1")},
		establish: []bool{true},
		finalOK:   true,
	}
	mech := newKerberosMechanismWith(hs)
	session, first, err := mech.Authenticate(context.Background(), "broker1:9092")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if string(first) != "init-token" {
		t.Fatalf("unexpected initial token %q", first)
	}
	done, reply, err := session.Challenge([]byte("server-challenge"))
	if err != nil || done {
		t.Fatalf("first challenge: done=%v reply=%q err=%v", done, reply, err)
	}
	if string(reply) != "reply-1" {
		t.Fatalf("unexpected continue reply %q", reply)
	}
	done, reply, err = session.Challenge([]byte("server-final"))
	if err != nil || !done || reply != nil {
		t.Fatalf("final challenge: done=%v reply=%q err=%v", done, reply, err)
	}
	want := []string{"initial", "continue", "final"}
	for i, c := range want {
		if hs.calls[i] != c {
			t.Fatalf("call %d: got %q want %q (all: %v)", i, hs.calls[i], c, hs.calls)
		}
	}
	if string(hs.challenges[0]) != "server-challenge" || string(hs.challenges[1]) != "server-final" {
		t.Fatalf("challenges not forwarded: %v", hs.challenges)
	}
}

func TestKerberosSessionPropagatesHandshakeErrors(t *testing.T) {
	// Empty script: the first Continue call exhausts it and errors.
	hs := &scriptedHandshaker{initial: []byte("x")}
	mech := newKerberosMechanismWith(hs)
	session, _, err := mech.Authenticate(context.Background(), "b:1")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if _, _, err := session.Challenge([]byte("c")); err == nil || !strings.Contains(err.Error(), "script exhausted") {
		t.Fatalf("expected continue error, got %v", err)
	}

	hs2 := &scriptedHandshaker{initial: []byte("x"), replies: [][]byte{nil}, establish: []bool{true}, finalOK: false}
	session2, _, err := newKerberosMechanismWith(hs2).Authenticate(context.Background(), "b:1")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if _, _, err := session2.Challenge([]byte("c")); err == nil || !strings.Contains(err.Error(), "bad final token") {
		t.Fatalf("expected final error, got %v", err)
	}
}

func TestKerberosMechanismName(t *testing.T) {
	if got := newKerberosMechanismWith(&scriptedHandshaker{}).Name(); got != "GSSAPI" {
		t.Fatalf("mechanism name %q, want GSSAPI", got)
	}
}

func TestBuildSPNUsesServiceNameAndHostWithoutPort(t *testing.T) {
	cases := []struct{ host, want string }{
		{"broker1:9092", "kafka/broker1"},
		{"10.0.0.5", "kafka/10.0.0.5"},
	}
	for _, tc := range cases {
		if got := buildSPN("kafka", tc.host); got != tc.want {
			t.Fatalf("buildSPN(%q) = %q, want %q", tc.host, got, tc.want)
		}
	}
}

func TestRealmFromPrincipal(t *testing.T) {
	cases := []struct{ principal, want string }{
		{"admin/admin@YHSJ.COM", "YHSJ.COM"},
		{"user@REALM2", "REALM2"},
	}
	for _, tc := range cases {
		if got, err := realmFromPrincipal(tc.principal); err != nil || got != tc.want {
			t.Fatalf("realmFromPrincipal(%q) = %q, %v; want %q", tc.principal, got, err, tc.want)
		}
	}
	if _, err := realmFromPrincipal("no-realm"); err == nil {
		t.Fatal("principal without realm must error")
	}
}

// The production factory validates kerberos file paths before any network
// I/O so a wrong path fails with a precise message.
func TestNewGokrb5HandshakerFactoryValidatesFiles(t *testing.T) {
	missing := func() model.SASLConfig {
		c := kerberosTestConfig()
		c.Krb5ConfPath = "/nonexistent/krb5.conf"
		return c
	}
	if _, err := newGokrb5HandshakerFactory(missing())(context.Background(), "broker1:9092"); err == nil || !strings.Contains(err.Error(), "krb5.conf") {
		t.Fatalf("expected krb5.conf load error, got %v", err)
	}
	krb5 := t.TempDir() + "/krb5.conf"
	if err := os.WriteFile(krb5, []byte("[libdefaults]\n default_realm = YHSJ.COM\n"), 0o644); err != nil {
		t.Fatalf("write krb5.conf: %v", err)
	}
	withKrb5 := func() model.SASLConfig {
		c := kerberosTestConfig()
		c.Krb5ConfPath = krb5
		return c
	}
	if _, err := newGokrb5HandshakerFactory(withKrb5())(context.Background(), "broker1:9092"); err == nil || !strings.Contains(err.Error(), "keytab") {
		t.Fatalf("expected keytab load error, got %v", err)
	}
}

// ---- raw KRB5 机制令牌(Java broker 所需帧)的单元测试 ----

// krb5TestSessionKey 生成测试用会话密钥(aes256-cts-hmac-sha1-96,32 字节随机)。
func krb5TestSessionKey(t *testing.T) types.EncryptionKey {
	t.Helper()
	key := make([]byte, 32)
	if _, err := crand.Read(key); err != nil {
		t.Fatalf("生成测试密钥: %v", err)
	}
	return types.EncryptionKey{KeyType: etypeID.AES256_CTS_HMAC_SHA1_96, KeyValue: key}
}

// krb5TokenFrame 把 tokID 与消息体包成 krb5 机制 GSS 帧:
// [APPLICATION 0] { OID krb5, tokID, 消息体 },即 RFC 4121 的初始上下文令牌帧。
func krb5TokenFrame(t *testing.T, tokID []byte, body []byte) []byte {
	t.Helper()
	oid, err := goforkasn1.Marshal(gssapi.OIDKRB5.OID())
	if err != nil {
		t.Fatalf("编码 krb5 OID: %v", err)
	}
	b := append(append(oid, tokID...), body...)
	return asn1tools.AddASNAppTag(b, 0)
}

// krb5APRepFrame 构造最小合法的 AP-REP 帧(MsgType=KRB_AP_REP=15)。
func krb5APRepFrame(t *testing.T) []byte {
	t.Helper()
	seq, err := goforkasn1.Marshal(struct {
		PVNO    int                 `asn1:"explicit,tag:0"`
		MsgType int                 `asn1:"explicit,tag:1"`
		EncPart types.EncryptedData `asn1:"explicit,tag:2"`
	}{PVNO: 5, MsgType: 15})
	if err != nil {
		t.Fatalf("编码 AP-REP 消息体: %v", err)
	}
	body := asn1tools.AddASNAppTag(seq, 15) // asnAppTag.APREP
	return krb5TokenFrame(t, []byte{0x02, 0x00}, body)
}

// krb5APReqFrame 走 gokrb5 真实路径构造 AP-REQ 帧(与 Initial 发出的帧同源)。
func krb5APReqFrame(t *testing.T, key types.EncryptionKey) []byte {
	t.Helper()
	cl := client.NewWithKeytab("admin", "YHSJ.COM", keytab.New(), config.New())
	tkt := messages.Ticket{SName: types.PrincipalName{NameType: nametype.KRB_NT_SRV_HST, NameString: []string{"broker1"}}}
	tok, err := spnego.NewKRB5TokenAPREQ(cl, tkt, key,
		[]int{gssapi.ContextFlagInteg, gssapi.ContextFlagConf}, []int{})
	if err != nil {
		t.Fatalf("构造 AP-REQ: %v", err)
	}
	b, err := tok.Marshal()
	if err != nil {
		t.Fatalf("编码 AP-REQ: %v", err)
	}
	return b
}

// krb5ErrorFrame 构造携带 KRB-ERROR 的 krb5 机制帧。
func krb5ErrorFrame(t *testing.T, code int32, etext string) []byte {
	t.Helper()
	ke := messages.NewKRBError(types.PrincipalName{}, "YHSJ.COM", code, etext)
	body, err := ke.Marshal()
	if err != nil {
		t.Fatalf("编码 KRB-ERROR: %v", err)
	}
	return krb5TokenFrame(t, []byte{0x03, 0x00}, body)
}

// acceptorWrapToken 构造服务端(acceptor)方向的 GSS wrap 令牌。
func acceptorWrapToken(t *testing.T, key types.EncryptionKey, payload []byte) []byte {
	t.Helper()
	et, err := gokrb5crypto.GetEtype(key.KeyType)
	if err != nil {
		t.Fatalf("获取加密类型: %v", err)
	}
	wt := &gssapi.WrapToken{
		Flags:   0x01, // acceptor 标志
		EC:      uint16(et.GetHMACBitLength() / 8),
		Payload: payload,
	}
	if err := wt.SetCheckSum(key, keyusage.GSSAPI_ACCEPTOR_SEAL); err != nil {
		t.Fatalf("计算 wrap 校验和: %v", err)
	}
	b, err := wt.Marshal()
	if err != nil {
		t.Fatalf("编码 wrap 令牌: %v", err)
	}
	return b
}

// classifyKrb5ServerToken 必须区分 AP-REP、AP-REQ、KRB-ERROR 与非 krb5 帧
// (GSS wrap 令牌、垃圾字节),KRB-ERROR 需带出错误码与文本。
func TestClassifyKrb5ServerToken(t *testing.T) {
	key := krb5TestSessionKey(t)

	if kind, err := classifyKrb5ServerToken(krb5APRepFrame(t)); err != nil || kind != krb5TokenAPRep {
		t.Fatalf("AP-REP 帧分类 = %v, %v; want %v", kind, err, krb5TokenAPRep)
	}
	if kind, err := classifyKrb5ServerToken(krb5APReqFrame(t, key)); err != nil || kind != krb5TokenAPReq {
		t.Fatalf("AP-REQ 帧分类 = %v, %v; want %v", kind, err, krb5TokenAPReq)
	}
	kind, err := classifyKrb5ServerToken(krb5ErrorFrame(t, int32(errorcode.KDC_ERR_S_PRINCIPAL_UNKNOWN), "Server not found in Kerberos database"))
	if kind != krb5TokenKRBError || err == nil || !strings.Contains(err.Error(), "Server not found in Kerberos database") {
		t.Fatalf("KRB-ERROR 帧分类 = %v, %v; want %v 且含错误文本", kind, err, krb5TokenKRBError)
	}
	wrapTok, err := gssapi.NewInitiatorWrapToken([]byte("s1"), key)
	if err != nil {
		t.Fatalf("构造 wrap 令牌: %v", err)
	}
	wb, err := wrapTok.Marshal()
	if err != nil {
		t.Fatalf("编码 wrap 令牌: %v", err)
	}
	if kind, err := classifyKrb5ServerToken(wb); err != nil || kind != krb5TokenOther {
		t.Fatalf("wrap 令牌分类 = %v, %v; want %v", kind, err, krb5TokenOther)
	}
	if kind, err := classifyKrb5ServerToken([]byte{0xde, 0xad}); err != nil || kind != krb5TokenOther {
		t.Fatalf("垃圾字节分类 = %v, %v; want %v", kind, err, krb5TokenOther)
	}
}

// gssapiSaslChoice 必须依据服务端 S1 载荷选择"无安全层"(RFC 4752 的 0x01),
// 并在服务端不提供该选项或载荷过短时给出可定位的错误。
func TestGssapiSaslChoice(t *testing.T) {
	choice, err := gssapiSaslChoice([]byte{0x07, 0x00, 0x01, 0x00})
	if err != nil || !bytes.Equal(choice, []byte{0x01, 0x00, 0x00, 0x00}) {
		t.Fatalf("安全层选择 = %v, %v; want 01 00 00 00", choice, err)
	}
	if _, err := gssapiSaslChoice([]byte{0x06, 0x00, 0x00, 0x00}); err == nil || !strings.Contains(err.Error(), "无安全层") {
		t.Fatalf("服务端不支持无安全层时应报错, got %v", err)
	}
	if _, err := gssapiSaslChoice([]byte{0x01}); err == nil {
		t.Fatal("S1 载荷过短时应报错")
	}
}

// unwrapServerWrapToken 必须校验 acceptor 方向 wrap 令牌并返回明文载荷。
func TestUnwrapServerWrapToken(t *testing.T) {
	key := krb5TestSessionKey(t)
	s1 := []byte{0x07, 0x00, 0x01, 0x00}
	payload, err := unwrapServerWrapToken(acceptorWrapToken(t, key, s1), key)
	if err != nil || !bytes.Equal(payload, s1) {
		t.Fatalf("unwrap = %v, %v; want %v", payload, err, s1)
	}
	// 发起方方向的令牌按 acceptor 校验必须失败
	initTok, err := gssapi.NewInitiatorWrapToken(s1, key)
	if err != nil {
		t.Fatalf("构造发起方 wrap 令牌: %v", err)
	}
	ib, err := initTok.Marshal()
	if err != nil {
		t.Fatalf("编码发起方 wrap 令牌: %v", err)
	}
	if _, err := unwrapServerWrapToken(ib, key); err == nil {
		t.Fatal("发起方令牌不应通过 acceptor 校验")
	}
}

// Continue 覆盖真实握手的三种服务端令牌:AP-REP(mutual 场景,回空令牌等待 S1)、
// wrap(S1)(回复客户端安全层选择并标记 established)、KRB-ERROR/垃圾(报错)。
func TestGokrb5HandshakerContinue(t *testing.T) {
	key := krb5TestSessionKey(t)
	h := &gokrb5Handshaker{sessionKey: key}
	ctx := context.Background()

	est, reply, err := h.Continue(ctx, krb5APRepFrame(t))
	if err != nil || est || len(reply) != 0 {
		t.Fatalf("Continue(AP-REP) = %v, %q, %v; want established=false 且空应答", est, reply, err)
	}

	s1 := []byte{0x07, 0x00, 0x01, 0x00}
	est, reply, err = h.Continue(ctx, acceptorWrapToken(t, key, s1))
	if err != nil || !est || len(reply) == 0 {
		t.Fatalf("Continue(S1) = %v, %q, %v; want established=true 且带回复", est, reply, err)
	}
	var wt gssapi.WrapToken
	if err := wt.Unmarshal(reply, false); err != nil {
		t.Fatalf("解析客户端选择 wrap 令牌: %v", err)
	}
	if ok, err := wt.Verify(key, keyusage.GSSAPI_INITIATOR_SEAL); err != nil || !ok {
		t.Fatalf("校验客户端选择 wrap 令牌: ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(wt.Payload, []byte{0x01, 0x00, 0x00, 0x00}) {
		t.Fatalf("客户端选择载荷 = %v; want 01 00 00 00", wt.Payload)
	}

	if _, _, err := h.Continue(ctx, krb5ErrorFrame(t, int32(errorcode.KDC_ERR_S_PRINCIPAL_UNKNOWN), "boom")); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("Continue(KRB-ERROR) 应携带错误文本, got %v", err)
	}
	if _, _, err := h.Continue(ctx, []byte{0xde, 0xad}); err == nil {
		t.Fatal("Continue(垃圾字节) 应报错")
	}
}

// Final 在服务端完成上下文后不再发送令牌(空挑战,OpenJDK GssKrb5Server 行为)
// 时直接成功;收到 wrap 令牌时校验;损坏的令牌必须报错。
func TestGokrb5HandshakerFinal(t *testing.T) {
	key := krb5TestSessionKey(t)
	h := &gokrb5Handshaker{sessionKey: key}
	ctx := context.Background()

	if err := h.Final(ctx, nil); err != nil {
		t.Fatalf("Final(空挑战) = %v; want nil", err)
	}
	good := acceptorWrapToken(t, key, []byte{})
	if err := h.Final(ctx, good); err != nil {
		t.Fatalf("Final(合法 wrap) = %v; want nil", err)
	}
	bad := append([]byte(nil), good...)
	bad[len(bad)-1] ^= 0xff // 破坏校验和
	if err := h.Final(ctx, bad); err == nil {
		t.Fatal("Final(损坏 wrap) 应报错")
	}
}
