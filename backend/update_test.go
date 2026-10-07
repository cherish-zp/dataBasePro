package backend

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	cases := []struct {
		tag string
		ok  bool
		v   version
	}{
		{"v1.0.0", true, version{1, 0, 0}},
		{"1.2.3", true, version{1, 2, 3}},
		{"v1.0", true, version{1, 0, 0}},
		{"v2.1.0-rc", false, version{}},
		{"latest", false, version{}},
		{"", false, version{}},
	}
	for _, c := range cases {
		v, ok := parseVersion(c.tag)
		if ok != c.ok || (ok && v != c.v) {
			t.Fatalf("parseVersion(%q) = %v, %v; want %v, %v", c.tag, v, ok, c.v, c.ok)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	if compareVersions(version{1, 0, 0}, version{1, 0, 0}) != 0 {
		t.Fatal("equal versions must compare 0")
	}
	if compareVersions(version{1, 1, 0}, version{1, 0, 9}) <= 0 {
		t.Fatal("1.1.0 must be newer than 1.0.9")
	}
	if compareVersions(version{2, 0, 0}, version{1, 9, 9}) <= 0 {
		t.Fatal("2.0.0 must be newer than 1.9.9")
	}
	if compareVersions(version{0, 9, 0}, version{1, 0, 0}) >= 0 {
		t.Fatal("0.9.0 must be older than 1.0.0")
	}
}

func fakeGiteeServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/releases/latest") {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newUpdateApp(t *testing.T, srv *httptest.Server) *App {
	t.Helper()
	a := &App{}
	a.baseURL.Store(srv.URL)
	a.httpClient = srv.Client()
	a.applyCmd = func(*exec.Cmd) error { return nil }
	return a
}

func TestCheckUpdateFindsNewerVersion(t *testing.T) {
	srv := fakeGiteeServer(t, `{
	  "tag_name": "v1.1.0",
	  "body": "修复若干问题",
	  "assets": [
	    {"name": "圣手运河-v1.1.0-darwin-arm64.zip", "browser_download_url": "http://x/mac-arm.zip"},
	    {"name": "圣手运河-v1.1.0-darwin-amd64.zip", "browser_download_url": "http://x/mac-intel.zip"},
	    {"name": "圣手运河-v1.1.0-windows-amd64.zip", "browser_download_url": "http://x/win.zip"}
	  ]
	}`)
	app := newUpdateApp(t, srv)
	setRuntime(t, "darwin", "arm64")
	res, err := app.CheckUpdate(CheckUpdateRequest{CurrentVersion: "v1.0.0"})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if !res.HasUpdate || res.LatestVersion != "v1.1.0" {
		t.Fatalf("expected update to v1.1.0, got %+v", res)
	}
	if res.Notes == "" {
		t.Fatal("notes must be carried through")
	}
	if !strings.HasSuffix(res.DownloadURL, "mac-arm.zip") {
		t.Fatalf("expected darwin-arm64 asset, got %q", res.DownloadURL)
	}
}

// TestCheckUpdatePicksAssetByArch 验证 Intel mac 命中 amd64 资产。
func TestCheckUpdatePicksAssetByArch(t *testing.T) {
	srv := fakeGiteeServer(t, `{
	  "tag_name": "v1.1.0",
	  "assets": [
	    {"name": "圣手运河-v1.1.0-darwin-arm64.zip", "browser_download_url": "http://x/mac-arm.zip"},
	    {"name": "圣手运河-v1.1.0-darwin-amd64.zip", "browser_download_url": "http://x/mac-intel.zip"}
	  ]
	}`)
	app := newUpdateApp(t, srv)
	setRuntime(t, "darwin", "amd64")
	res, err := app.CheckUpdate(CheckUpdateRequest{CurrentVersion: "v1.0.0"})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if !strings.HasSuffix(res.DownloadURL, "mac-intel.zip") {
		t.Fatalf("expected darwin-amd64 asset, got %q", res.DownloadURL)
	}
}

// setRuntime 覆盖平台探测变量,测试结束自动还原。
func setRuntime(t *testing.T, goos, goarch string) {
	t.Helper()
	oldGOOS, oldGOARCH := runtimeGOOS, runtimeGOARCH
	runtimeGOOS, runtimeGOARCH = goos, goarch
	t.Cleanup(func() { runtimeGOOS, runtimeGOARCH = oldGOOS, oldGOARCH })
}

func TestCheckUpdateReportsUpToDate(t *testing.T) {
	srv := fakeGiteeServer(t, `{"tag_name":"v1.0.0","body":"","assets":[{"name":"a-macOS.zip","browser_download_url":"u"}]}`)
	res, err := newUpdateApp(t, srv).CheckUpdate(CheckUpdateRequest{CurrentVersion: "v1.0.0"})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if res.HasUpdate {
		t.Fatalf("equal version must not flag update: %+v", res)
	}
}

func TestCheckUpdateIgnoresNonSemverTag(t *testing.T) {
	srv := fakeGiteeServer(t, `{"tag_name":"v1.1.0-rc.1","body":"","assets":[{"name":"a-macOS.zip","browser_download_url":"u"}]}`)
	res, err := newUpdateApp(t, srv).CheckUpdate(CheckUpdateRequest{CurrentVersion: "v1.0.0"})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if res.HasUpdate {
		t.Fatalf("pre-release tag must be ignored: %+v", res)
	}
}

func TestPickAssetURL(t *testing.T) {
	rel := giteeRelease{Assets: []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	}{
		{Name: "圣手运河-v1.6.0-darwin-amd64.zip", BrowserDownloadURL: "intel"},
		{Name: "圣手运河-v1.6.0-darwin-arm64.zip", BrowserDownloadURL: "arm"},
		{Name: "圣手运河-v1.6.0-windows-amd64.zip", BrowserDownloadURL: "win"},
		{Name: "v1.6.0.zip", BrowserDownloadURL: "source"},
	}}
	if got := pickAssetURL(rel, "darwin", "arm64"); got != "arm" {
		t.Fatalf("darwin/arm64 asset = %q, want arm", got)
	}
	if got := pickAssetURL(rel, "darwin", "amd64"); got != "intel" {
		t.Fatalf("darwin/amd64 asset = %q, want intel", got)
	}
	if got := pickAssetURL(rel, "windows", "amd64"); got != "win" {
		t.Fatalf("windows/amd64 asset = %q, want win", got)
	}
	// 上游只有单一 darwin 包时按系统名兜底,源码包永不被选中。
	single := giteeRelease{Assets: rel.Assets[1:2]}
	if got := pickAssetURL(single, "darwin", "amd64"); got != "arm" {
		t.Fatalf("darwin amd64 must fall back to the only darwin asset, got %q", got)
	}
	if got := pickAssetURL(giteeRelease{}, "darwin", "arm64"); got != "" {
		t.Fatalf("missing asset must yield empty, got %q", got)
	}
	sourceOnly := giteeRelease{Assets: []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	}{{Name: "v1.6.0.zip", BrowserDownloadURL: "source"}}}
	if got := pickAssetURL(sourceOnly, "darwin", "arm64"); got != "" {
		t.Fatalf("source archive must never be picked, got %q", got)
	}
}

// makeUpdateZip writes a zip containing a minimal 圣手运河.app tree.
func makeUpdateZip(t *testing.T, path string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(w, content)
	}
	add("圣手运河.app/Contents/", "")
	add("圣手运河.app/Contents/MacOS/圣手运河", "#!/bin/sh\n")
	add("圣手运河.app/Contents/Info.plist", "<plist/>")
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadUpdateUnzipsApp(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "u.zip")
	makeUpdateZip(t, zipPath)
	data, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(data)
	}))
	defer srv.Close()
	app := newUpdateApp(t, srv)

	if err := app.DownloadUpdate(DownloadUpdateRequest{URL: srv.URL + "/u.zip"}); err != nil {
		t.Fatalf("DownloadUpdate: %v", err)
	}
	staging := app.stagingDir.Load().(string)
	if !strings.HasPrefix(filepath.Base(staging), "sheng-shou-yun-he-update-") {
		t.Fatalf("staging dir must use the sheng-shou-yun-he-update- prefix, got %q", staging)
	}
	bin := filepath.Join(staging, "圣手运河.app", "Contents", "MacOS", "圣手运河")
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("expected extracted binary, got %v", err)
	}
	prog := app.UpdateProgress()
	if prog.Phase != "done" || prog.Percent != 100 {
		t.Fatalf("unexpected progress %+v", prog)
	}
}

func TestDownloadUpdateHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	app := newUpdateApp(t, srv)
	if err := app.DownloadUpdate(DownloadUpdateRequest{URL: srv.URL + "/x"}); err == nil {
		t.Fatal("expected download error")
	}
	if app.UpdateProgress().Phase != "error" {
		t.Fatalf("progress must be error, got %+v", app.UpdateProgress())
	}
}

// makeWindowsUpdateZip writes a zip containing only the payload exe
// (与发布流水线的 windows 包形状一致)。
func makeWindowsUpdateZip(t *testing.T, path string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("圣手运河.exe")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(w, "MZ fake exe")
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDownloadUpdateWindowsStagesExe 验证 Windows 下载后把解压出的 exe 放进
// 暂存目录(不再丢到「下载」文件夹等手动安装)。
func TestDownloadUpdateWindowsStagesExe(t *testing.T) {
	setRuntime(t, "windows", "amd64")
	zipPath := filepath.Join(t.TempDir(), "u.zip")
	makeWindowsUpdateZip(t, zipPath)
	data, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(data)
	}))
	defer srv.Close()
	app := newUpdateApp(t, srv)

	if err := app.DownloadUpdate(DownloadUpdateRequest{URL: srv.URL + "/u.zip"}); err != nil {
		t.Fatalf("DownloadUpdate: %v", err)
	}
	staging := app.stagingDir.Load().(string)
	if _, err := os.Stat(filepath.Join(staging, "圣手运河.exe")); err != nil {
		t.Fatalf("expected staged exe, got %v", err)
	}
	if app.UpdateProgress().Phase != "done" {
		t.Fatalf("unexpected progress %+v", app.UpdateProgress())
	}
}

func TestApplyUpdateRequiresStaging(t *testing.T) {
	app := newUpdateApp(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})))
	if err := app.ApplyUpdate(ApplyUpdateRequest{}); err == nil {
		t.Fatal("expected error without staged update")
	}
}

// TestBundleFromExe 验证从可执行文件路径反查 .app 包目录。
func TestBundleFromExe(t *testing.T) {
	bundle, err := bundleFromExe("/Applications/圣手运河.app/Contents/MacOS/圣手运河")
	if err != nil || bundle != "/Applications/圣手运河.app" {
		t.Fatalf("bundleFromExe = %q, %v", bundle, err)
	}
	if _, err := bundleFromExe("/opt/homebrew/bin/圣手运河"); err == nil {
		t.Fatal("non-bundle executable must fail")
	}
}

// TestBuildUpdaterScriptSwapsInPlace 验证 macOS 脚本原位替换:旧包改名备份,
// 新包 ditto 到运行位置,启动失败自动还原;不再写死 /Applications。
func TestBuildUpdaterScriptSwapsInPlace(t *testing.T) {
	s := buildUpdaterScript("/tmp/stage", "/Applications/圣手运河.app")
	for _, want := range []string{
		`SRC="/tmp/stage/圣手运河.app"`,
		`TARGET="/Applications/圣手运河.app"`,
		`mv "$TARGET" "$BACKUP"`,
		`ditto "$SRC" "$TARGET"`,
		`open "$TARGET"`,
		`pgrep -x 圣手运河`,
		`mv "$BACKUP" "$TARGET"`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("script missing %q:\n%s", want, s)
		}
	}
}

// TestBuildWindowsUpdaterScript 验证 Windows 脚本:等待退出 → 旧 exe 原地
// 改名(运行中的 exe 允许改名)→ 复制新 exe → 启动 → 清理备份,复制失败还原。
// 脚本含中文 exe 名,必须在 @echo off 后先切 UTF-8 代码页。
func TestBuildWindowsUpdaterScript(t *testing.T) {
	s := buildWindowsUpdaterScript(`C:\stage`, `C:\Apps\圣手运河.exe`)
	for _, want := range []string{
		`@echo off`,
		`chcp 65001 >nul`,
		`move /Y "C:\Apps\圣手运河.exe" "C:\Apps\圣手运河.exe.old"`,
		`copy /Y "C:\stage\圣手运河.exe" "C:\Apps\圣手运河.exe"`,
		`start "" "C:\Apps\圣手运河.exe"`,
		`del "C:\Apps\圣手运河.exe.old"`,
		`move /Y "C:\Apps\圣手运河.exe.old" "C:\Apps\圣手运河.exe"`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("script missing %q:\n%s", want, s)
		}
	}
	if !strings.Contains(s, "@echo off\r\nchcp 65001 >nul") {
		t.Fatalf("chcp 65001 must come right after @echo off:\n%s", s)
	}
}

// TestApplyUpdateSpawnsScriptWhenStaged 验证 macOS 用运行位置生成替换脚本
// 并以分离进程启动。
func TestApplyUpdateSpawnsScriptWhenStaged(t *testing.T) {
	staging := t.TempDir()
	appDir := filepath.Join(staging, "圣手运河.app")
	os.MkdirAll(filepath.Join(appDir, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(appDir, "Contents", "MacOS", "圣手运河"), []byte("x"), 0o755)
	os.WriteFile(filepath.Join(appDir, "Contents", "Info.plist"), []byte("<x/>"), 0o644)
	setRuntime(t, "darwin", "arm64")
	oldExePath := exePath
	exePath = func() (string, error) {
		return "/Applications/圣手运河.app/Contents/MacOS/圣手运河", nil
	}
	t.Cleanup(func() { exePath = oldExePath })

	var started []string
	app := newUpdateApp(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})))
	app.applyCmd = func(cmd *exec.Cmd) error {
		started = append(started, strings.Join(cmd.Args, " "))
		return nil
	}
	app.stagingDir.Store(staging)
	if err := app.ApplyUpdate(ApplyUpdateRequest{}); err != nil {
		t.Fatalf("ApplyUpdate: %v", err)
	}
	if len(started) != 1 || !strings.Contains(started[0], "apply-update.sh") {
		t.Fatalf("expected detached script start, got %v", started)
	}
	data, err := os.ReadFile(filepath.Join(staging, "apply-update.sh"))
	if err != nil {
		t.Fatalf("script not written: %v", err)
	}
	if !strings.Contains(string(data), `TARGET="/Applications/圣手运河.app"`) {
		t.Fatalf("script must target the running install location:\n%s", data)
	}
}

// TestApplyUpdateWindowsRunsBat 验证 Windows 分支:定位暂存 exe,生成 bat,
// 经 cmd /c 分离启动。
func TestApplyUpdateWindowsRunsBat(t *testing.T) {
	setRuntime(t, "windows", "amd64")
	staging := t.TempDir()
	os.WriteFile(filepath.Join(staging, "圣手运河.exe"), []byte("MZ"), 0o755)
	oldExePath := exePath
	exePath = func() (string, error) { return `C:\Apps\圣手运河.exe`, nil }
	t.Cleanup(func() { exePath = oldExePath })

	var started []string
	app := newUpdateApp(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})))
	app.applyCmd = func(cmd *exec.Cmd) error {
		started = append(started, strings.Join(cmd.Args, " "))
		return nil
	}
	app.stagingDir.Store(staging)
	if err := app.ApplyUpdate(ApplyUpdateRequest{}); err != nil {
		t.Fatalf("ApplyUpdate: %v", err)
	}
	if len(started) != 1 || !strings.Contains(started[0], "apply-update.bat") {
		t.Fatalf("expected cmd /c bat start, got %v", started)
	}
	data, err := os.ReadFile(filepath.Join(staging, "apply-update.bat"))
	if err != nil {
		t.Fatalf("script not written: %v", err)
	}
	if !strings.Contains(string(data), `copy /Y `) {
		t.Fatalf("unexpected bat content:\n%s", data)
	}
}
