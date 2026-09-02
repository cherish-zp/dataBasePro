// Kerberos (GSSAPI) SASL support. franz-go defines the SASL session
// protocol; the GSSAPI token exchange itself is delegated to a pluggable
// handshaker so the wire flow can be unit tested with a scripted fake
// (kfake cannot simulate Kerberos) while production plugs in gokrb5.
//
// The production handshaker speaks raw krb5 mechanism tokens (GSS header
// with OID 1.2.840.113554.1.2.2, RFC 4121) — Java brokers run SASL/GSSAPI
// on a KRB5_OID GSSContext and reject SPNEGO negotiation tokens — and
// follows RFC 4752: AP-REQ → [AP-REP] → server wrap(S1) → client
// wrap(selection) → done.
package kafka

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/spnego"
	"github.com/jcmturner/gokrb5/v8/types"
	"github.com/twmb/franz-go/pkg/sasl"

	"dataBasePro/backend/internal/model"
)

// kerberosHandshaker drives one GSSAPI context negotiation: Initial produces
// the client's first token, Continue consumes a server token and reports
// whether the security context is established (reply is the next client
// token to write, empty when none), and Final validates the server's closing
// wrap token (an empty challenge means the server completed without one).
type kerberosHandshaker interface {
	Initial(ctx context.Context) ([]byte, error)
	Continue(ctx context.Context, challenge []byte) (established bool, reply []byte, err error)
	Final(ctx context.Context, challenge []byte) error
}

// kerberosMechanism adapts the handshaker to franz-go's sasl.Mechanism.
type kerberosMechanism struct {
	newHandshaker func(ctx context.Context, host string) (kerberosHandshaker, error)
}

// newKerberosMechanismWith binds a ready handshaker (tests).
func newKerberosMechanismWith(hs kerberosHandshaker) sasl.Mechanism {
	return &kerberosMechanism{newHandshaker: func(context.Context, string) (kerberosHandshaker, error) { return hs, nil }}
}

func (m *kerberosMechanism) Name() string { return model.SaslGssapi }

func (m *kerberosMechanism) Authenticate(ctx context.Context, host string) (sasl.Session, []byte, error) {
	hs, err := m.newHandshaker(ctx, host)
	if err != nil {
		return nil, nil, fmt.Errorf("kerberos 初始化失败: %w", err)
	}
	first, err := hs.Initial(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("kerberos 初始令牌: %w", err)
	}
	return &kerberosSession{ctx: ctx, hs: hs}, first, nil
}

// kerberosSession implements sasl.Session. Wire sequence after the initial
// token: continue tokens flow both ways until the context is established
// (the establishment reply — the RFC 4752 security-layer selection wrap
// token — is written first if present), then the server's closing token is
// validated (an empty payload means the server completed without one) and
// authentication completes.
type kerberosSession struct {
	ctx         context.Context
	hs          kerberosHandshaker
	established bool
}

func (s *kerberosSession) Challenge(challenge []byte) (bool, []byte, error) {
	if !s.established {
		est, reply, err := s.hs.Continue(s.ctx, challenge)
		if err != nil {
			return false, nil, err
		}
		s.established = est
		if !est || len(reply) > 0 {
			return false, reply, nil
		}
		// Established with nothing left to write: the current challenge is
		// already the closing token.
	}
	if err := s.hs.Final(s.ctx, challenge); err != nil {
		return false, nil, err
	}
	return true, nil, nil
}

// realmFromPrincipal splits "user/host@REALM" into its realm part.
func realmFromPrincipal(principal string) (string, error) {
	idx := strings.LastIndex(principal, "@")
	if idx <= 0 || idx == len(principal)-1 {
		return "", fmt.Errorf("principal %q 缺少 @REALM 部分", principal)
	}
	return principal[idx+1:], nil
}

// buildSPN composes the Kafka service principal "<service>/<broker host>";
// the port is not part of the service principal.
func buildSPN(serviceName, host string) string {
	hostOnly := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostOnly = h
	}
	return serviceName + "/" + hostOnly
}

// RFC 4752 安全层选择位:0x01 表示无安全层(与 Java 客户端 qop=auth 时的行为一致)。
const gssapiSaslNoLayer byte = 0x01

// krb5ServerTokenKind 按 krb5 机制帧(RFC 4121 GSS 头 + TOK_ID)解析服务端令牌的类别。
type krb5ServerTokenKind int

const (
	krb5TokenOther    krb5ServerTokenKind = iota // 非 krb5 机制帧(按 GSS wrap 令牌处理)
	krb5TokenAPRep                               // AP-REP:GSS 上下文已建立
	krb5TokenAPReq                               // AP-REQ:建立阶段的非预期令牌
	krb5TokenKRBError                            // KRB-ERROR:服务端拒绝
)

// classifyKrb5ServerToken 判定服务端令牌类别。非 krb5 机制帧返回 krb5TokenOther
// (交由 GSS wrap 令牌路径处理);KRB-ERROR 时 err 携带错误码与文本以便定位。
func classifyKrb5ServerToken(b []byte) (krb5ServerTokenKind, error) {
	var tok spnego.KRB5Token
	if err := tok.Unmarshal(b); err != nil {
		return krb5TokenOther, nil
	}
	switch {
	case tok.IsAPRep():
		return krb5TokenAPRep, nil
	case tok.IsAPReq():
		return krb5TokenAPReq, nil
	case tok.IsKRBError():
		return krb5TokenKRBError, fmt.Errorf("服务端返回 KRB-ERROR(code %d): %s", tok.KRBError.ErrorCode, tok.KRBError.EText)
	}
	return krb5TokenOther, nil
}

// unwrapServerWrapToken 校验服务端(acceptor)方向的 GSS wrap 令牌并返回明文载荷。
func unwrapServerWrapToken(b []byte, key types.EncryptionKey) ([]byte, error) {
	var wt gssapi.WrapToken
	if err := wt.Unmarshal(b, true); err != nil {
		return nil, err
	}
	ok, err := wt.Verify(key, keyusage.GSSAPI_ACCEPTOR_SEAL)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("wrap 令牌校验未通过")
	}
	return wt.Payload, nil
}

// gssapiSaslChoice 构造 RFC 4752 安全层协商中客户端的响应载荷:
// 1 字节选择位掩码 + 3 字节最大接收缓冲区(未选安全层时必须为 0)。
// 本客户端不启用数据通道安全层,因此固定选择"无安全层";
// 若服务端未提供该选项则报错。
func gssapiSaslChoice(s1 []byte) ([]byte, error) {
	if len(s1) < 4 {
		return nil, fmt.Errorf("安全层协商载荷过短: %d 字节", len(s1))
	}
	if s1[0]&gssapiSaslNoLayer == 0 {
		return nil, fmt.Errorf("服务端不支持无安全层选项(提供的掩码 0x%02x)", s1[0])
	}
	return []byte{gssapiSaslNoLayer, 0, 0, 0}, nil
}

// gokrb5Handshaker is the production handshaker on top of jcmturner/gokrb5.
type gokrb5Handshaker struct {
	cl         *client.Client
	spn        string
	sessionKey types.EncryptionKey
}

// newGokrb5HandshakerFactory builds the handshaker factory used by
// clientOpts: it loads the keytab and krb5.conf eagerly so a wrong path fails
// with a precise message before any network I/O.
func newGokrb5HandshakerFactory(cfg model.SASLConfig) func(ctx context.Context, host string) (kerberosHandshaker, error) {
	return func(_ context.Context, host string) (kerberosHandshaker, error) {
		principal := strings.TrimSpace(cfg.Principal)
		realm, err := realmFromPrincipal(principal)
		if err != nil {
			return nil, err
		}
		user := principal[:strings.LastIndex(principal, "@")]
		kcfg, err := config.Load(cfg.Krb5ConfPath)
		if err != nil {
			return nil, fmt.Errorf("读取 krb5.conf %q: %w", cfg.Krb5ConfPath, err)
		}
		kt, err := keytab.Load(cfg.KeytabPath)
		if err != nil {
			return nil, fmt.Errorf("读取 keytab %q: %w", cfg.KeytabPath, err)
		}
		cl := client.NewWithKeytab(user, realm, kt, kcfg, client.DisablePAFXFAST(true))
		if err := cl.Login(); err != nil {
			return nil, fmt.Errorf("kerberos 认证 %q: %w", principal, err)
		}
		return &gokrb5Handshaker{cl: cl, spn: buildSPN(cfg.ServiceName, host)}, nil
	}
}

// Initial 产生 krb5 机制初始上下文令牌:GSS 头(krb5 OID + TOK_ID 0100)包
// AP-REQ,即 Java broker 的 KRB5_OID GSSContext 期望的裸机制令牌(RFC 4121),
// 而非 SPNEGO 协商令牌。
func (h *gokrb5Handshaker) Initial(_ context.Context) ([]byte, error) {
	tkt, skey, err := h.cl.GetServiceTicket(h.spn)
	if err != nil {
		return nil, fmt.Errorf("获取服务票据 %q: %w", h.spn, err)
	}
	h.sessionKey = skey
	// GSSAPIFlags 与 Java 客户端一致(Integ+Conf);APOptions 为空即不要求
	// mutual 认证,服务端建立上下文后直接进入安全层协商。
	tok, err := spnego.NewKRB5TokenAPREQ(h.cl, tkt, skey,
		[]int{gssapi.ContextFlagInteg, gssapi.ContextFlagConf}, []int{})
	if err != nil {
		return nil, fmt.Errorf("构造 KRB5 AP-REQ 令牌: %w", err)
	}
	b, err := tok.Marshal()
	if err != nil {
		return nil, fmt.Errorf("编码 KRB5 AP-REQ 令牌: %w", err)
	}
	return b, nil
}

// Continue 消费服务端令牌并推进 RFC 4752 交换:
//   - AP-REP(mutual 场景):GSS 上下文已建立,但按 RFC 2222 7.2.1 客户端
//     以空令牌应答,等待服务端的 wrap(S1)(established 仍为 false);
//   - GSS wrap(S1):服务端的安全层与缓冲区协商,解包校验后回复客户端选择,
//     上下文收尾(established=true,reply 为选择 wrap 令牌)。
func (h *gokrb5Handshaker) Continue(_ context.Context, challenge []byte) (bool, []byte, error) {
	kind, kerr := classifyKrb5ServerToken(challenge)
	switch kind {
	case krb5TokenAPRep:
		return false, []byte{}, nil
	case krb5TokenAPReq:
		return false, nil, errors.New("服务端返回了非预期的 AP-REQ 令牌")
	case krb5TokenKRBError:
		return false, nil, kerr
	}
	s1, err := unwrapServerWrapToken(challenge, h.sessionKey)
	if err != nil {
		return false, nil, fmt.Errorf("解析服务端安全层协商 wrap 令牌: %w", err)
	}
	choice, err := gssapiSaslChoice(s1)
	if err != nil {
		return false, nil, err
	}
	wrapTok, err := gssapi.NewInitiatorWrapToken(choice, h.sessionKey)
	if err != nil {
		return false, nil, fmt.Errorf("构造安全层选择 wrap 令牌: %w", err)
	}
	out, err := wrapTok.Marshal()
	if err != nil {
		return false, nil, fmt.Errorf("编码安全层选择 wrap 令牌: %w", err)
	}
	return true, out, nil
}

// Final 校验服务端结束消息:OpenJDK 的 GssKrb5Server 完成上下文后不再发送
// 令牌(空挑战);若收到 wrap 令牌(其他服务端实现的收尾形式)则校验之。
func (h *gokrb5Handshaker) Final(_ context.Context, challenge []byte) error {
	if len(challenge) == 0 {
		return nil
	}
	if _, err := unwrapServerWrapToken(challenge, h.sessionKey); err != nil {
		return fmt.Errorf("校验服务端结束 wrap 令牌: %w", err)
	}
	return nil
}
