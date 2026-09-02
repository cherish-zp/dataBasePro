package backend

import (
	"archive/zip"
	"bytes"
	"fmt"
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
	cases := []struct{ tag string; ok bool; v version }{
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
	    {"name": "dataBasePro-1.1.0-macOS.zip", "browser_download_url": "http://x/mac.zip"},
	    {"name": "dataBasePro-1.1.0-windows-amd64.zip", "browser_download_url": "http://x/win.zip"}
	  ]
	}`)
	app := newUpdateApp(t, srv)
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
	if !strings.HasSuffix(res.DownloadURL, "mac.zip") {
		t.Fatalf("expected macOS asset on darwin, got %q", res.DownloadURL)
	}
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
		{Name: "x-macOS.zip", BrowserDownloadURL: "m"},
		{Name: "x-windows-amd64.zip", BrowserDownloadURL: "w"},
	}}
	if got := pickAssetURL(rel, "darwin"); got != "m" {
		t.Fatalf("darwin asset = %q", got)
	}
	if got := pickAssetURL(rel, "windows"); got != "w" {
		t.Fatalf("windows asset = %q", got)
	}
	if got := pickAssetURL(giteeRelease{}, "darwin"); got != "" {
		t.Fatalf("missing asset must yield empty, got %q", got)
	}
}

// makeUpdateZip writes a zip containing a minimal dataBasePro.app tree.
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
	add("dataBasePro.app/Contents/", "")
	add("dataBasePro.app/Contents/MacOS/dataBasePro", "#!/bin/sh\n")
	add("dataBasePro.app/Contents/Info.plist", "<plist/>")
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
	bin := filepath.Join(staging, "dataBasePro.app", "Contents", "MacOS", "dataBasePro")
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

func TestApplyUpdateRequiresStaging(t *testing.T) {
	app := newUpdateApp(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})))
	if err := app.ApplyUpdate(ApplyUpdateRequest{}); err == nil {
		t.Fatal("expected error without staged update")
	}
}

func TestBuildUpdaterScriptSwapsAndRelaunches(t *testing.T) {
	s := buildUpdaterScript("/tmp/stage")
	for _, want := range []string{"sleep 1", "rm -rf /Applications/dataBasePro.app", `ditto "/tmp/stage/dataBasePro.app" /Applications/dataBasePro.app`, "open /Applications/dataBasePro.app"} {
		if !strings.Contains(s, want) {
			t.Fatalf("script missing %q:\n%s", want, s)
		}
	}
}

func TestApplyUpdateSpawnsScriptWhenStaged(t *testing.T) {
	staging := t.TempDir()
	appDir := filepath.Join(staging, "dataBasePro.app")
	os.MkdirAll(filepath.Join(appDir, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(appDir, "Contents", "MacOS", "dataBasePro"), []byte("x"), 0o755)
	os.WriteFile(filepath.Join(appDir, "Contents", "Info.plist"), []byte("<x/>"), 0o644)

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
	script := filepath.Join(staging, "apply-update.sh")
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("script not written: %v", err)
	}
	_ = fmt.Sprint() // keep fmt import used
}
