package backend

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 应用更新引擎:探测 Gitee Release(语义化版本比较),macOS 全自动替换
// 安装,Windows 下载到下载目录并定位(替换脚本后续补)。
// HTTP 依赖全部可注入,测试用 httptest 离线跑。

const (
	defaultUpdateBaseURL = "https://gitee.com/api/v5"
	updateOwner          = "princess-zp"
	updateRepo           = "dataBasePro"
)

// giteeRelease mirrors the subset of the Gitee Release payload we read.
type giteeRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// version is a parsed semantic version (major.minor.patch).
type version struct{ major, minor, patch int }

// parseVersion parses "vX.Y.Z" (leading v optional, patch optional).
func parseVersion(tag string) (version, bool) {
	t := strings.TrimSpace(tag)
	t = strings.TrimPrefix(t, "v")
	parts := strings.SplitN(t, ".", 3)
	if len(parts) < 2 {
		return version{}, false
	}
	nums := make([]int, 0, 3)
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return version{}, false
		}
		nums = append(nums, n)
	}
	v := version{major: nums[0], minor: nums[1]}
	if len(nums) > 2 {
		v.patch = nums[2]
	}
	return v, true
}

// compareVersions returns -1/0/1 when a is lower/equal/higher than b.
func compareVersions(a, b version) int {
	switch {
	case a.major != b.major:
		return cmpInt(a.major, b.major)
	case a.minor != b.minor:
		return cmpInt(a.minor, b.minor)
	default:
		return cmpInt(a.patch, b.patch)
	}
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// pickAssetURL selects the release asset for the current OS: macOS zips
// carry "macOS" in the name, Windows zips "windows".
func pickAssetURL(rel giteeRelease, goos string) string {
	key := "macOS"
	if goos == "windows" {
		key = "windows"
	}
	for _, a := range rel.Assets {
		if strings.Contains(a.Name, key) && a.BrowserDownloadURL != "" {
			return a.BrowserDownloadURL
		}
	}
	return ""
}

// CheckUpdateRequest carries the frontend's current version.
type CheckUpdateRequest struct {
	CurrentVersion string `json:"current_version"`
}

// UpdateCheckResult is the probe outcome surfaced to the UI.
type UpdateCheckResult struct {
	HasUpdate     bool   `json:"has_update"`
	LatestVersion string `json:"latest_version"`
	Notes         string `json:"notes,omitempty"`
	DownloadURL   string `json:"download_url,omitempty"`
}

// CheckUpdate probes the Gitee latest release and compares it against the
// running version (strict semantic comparison, pre-releases ignored).
func (a *App) CheckUpdate(req CheckUpdateRequest) (UpdateCheckResult, error) {
	cur, ok := parseVersion(req.CurrentVersion)
	if !ok {
		return UpdateCheckResult{}, fmt.Errorf("无法解析当前版本 %q", req.CurrentVersion)
	}
	url := fmt.Sprintf("%s/repos/%s/%s/releases/latest", a.updateBaseURL(), updateOwner, updateRepo)
	httpResp, err := a.updateHTTP().Get(url)
	if err != nil {
		return UpdateCheckResult{}, fmt.Errorf("探测更新失败(网络): %w", err)
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK {
		return UpdateCheckResult{}, fmt.Errorf("探测更新失败: HTTP %d", httpResp.StatusCode)
	}
	var rel giteeRelease
	if err := json.NewDecoder(httpResp.Body).Decode(&rel); err != nil {
		return UpdateCheckResult{}, fmt.Errorf("解析更新信息失败: %w", err)
	}
	latest, ok := parseVersion(rel.TagName)
	if !ok {
		return UpdateCheckResult{HasUpdate: false, LatestVersion: rel.TagName}, nil
	}
	res := UpdateCheckResult{LatestVersion: rel.TagName, Notes: rel.Body}
	if compareVersions(latest, cur) > 0 {
		res.HasUpdate = true
		res.DownloadURL = pickAssetURL(rel, goruntime.GOOS)
	}
	return res, nil
}

// --- 下载与安装 ---

// UpdateProgressInfo is polled by the frontend while downloading.
type UpdateProgressInfo struct {
	Phase   string `json:"phase"` // idle | downloading | done | error
	Percent int    `json:"percent"`
	Error   string `json:"error,omitempty"`
}

// downloadState is shared between the polled progress read and the writer.
type downloadState struct {
	phase   atomic.Int64 // 0 idle, 1 downloading, 2 done, 3 error
	percent atomic.Int64
	err     atomic.Value // string
}

func newDownloadState() *downloadState { return &downloadState{} }

// --- App 依赖 helpers(测试注入点) ---

func (a *App) updateBaseURL() string {
	if s, ok := a.baseURL.Load().(string); ok && s != "" {
		return s
	}
	return defaultUpdateBaseURL
}

func (a *App) updateHTTP() *http.Client {
	if a.httpClient != nil {
		return a.httpClient
	}
	return http.DefaultClient
}

func (a *App) downloadState() *downloadState {
	if a.dl == nil {
		a.dl = newDownloadState()
	}
	return a.dl
}

// apply runs the install script detached; tests inject a stub.
func (a *App) apply() func(cmd *exec.Cmd) error {
	if a.applyCmd != nil {
		return a.applyCmd
	}
	return func(cmd *exec.Cmd) error { return cmd.Start() }
}

// DownloadUpdateRequest carries the release asset URL to fetch.
type DownloadUpdateRequest struct {
	URL string `json:"url"`
}

// DownloadUpdate fetches the release asset and prepares it for install:
// macOS unzips the .app into a temp staging dir; Windows writes the zip into
// the user's Downloads and skips extraction (ApplyUpdate reveals it).
func (a *App) DownloadUpdate(req DownloadUpdateRequest) error {
	dl := a.downloadState()
	dl.phase.Store(1)
	dl.percent.Store(0)
	dl.err.Store("")
	defer func() {
		if r := recover(); r != nil {
			dl.phase.Store(3)
			dl.err.Store(fmt.Sprintf("%v", r))
			panic(r)
		}
	}()

	resp, err := a.updateHTTP().Get(req.URL)
	if err != nil {
		dl.phase.Store(3)
		dl.err.Store(fmt.Sprintf("下载失败: %v", err))
		return fmt.Errorf("download update: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		dl.phase.Store(3)
		dl.err.Store(fmt.Sprintf("下载失败: HTTP %d", resp.StatusCode))
		return fmt.Errorf("download update: HTTP %d", resp.StatusCode)
	}
	contentLength := resp.ContentLength

	if goruntime.GOOS == "windows" {
		name := filepath.Base(req.URL)
		if !strings.HasSuffix(strings.ToLower(name), ".zip") {
			name += ".zip"
		}
		dir, err := os.UserHomeDir()
		if err != nil {
			dl.phase.Store(3)
			dl.err.Store("无法定位下载目录")
			return fmt.Errorf("home dir: %w", err)
		}
		dest := filepath.Join(dir, "Downloads", name)
		if err := streamToFile(resp.Body, dest, contentLength, dl); err != nil {
			dl.err.Store(err.Error())
			return err
		}
		a.downloadPath.Store(dest)
		dl.phase.Store(2)
		dl.percent.Store(100)
		return nil
	}

	staging := filepath.Join(os.TempDir(), fmt.Sprintf("dataBasePro-update-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(staging, 0o755); err != nil {
		dl.phase.Store(3)
		dl.err.Store(fmt.Sprintf("创建暂存目录失败: %v", err))
		return err
	}
	zipPath := filepath.Join(staging, "update.zip")
	if err := streamToFile(resp.Body, zipPath, contentLength, dl); err != nil {
		dl.err.Store(err.Error())
		return err
	}
	if err := unzipApp(zipPath, staging); err != nil {
		dl.phase.Store(3)
		dl.err.Store(fmt.Sprintf("解压更新包失败: %v", err))
		return err
	}
	a.stagingDir.Store(staging)
	dl.phase.Store(2)
	dl.percent.Store(100)
	return nil
}

// streamToFile copies src to dest while updating the download progress.
func streamToFile(src io.Reader, dest string, total int64, dl *downloadState) error {
	out, err := os.Create(dest)
	if err != nil {
		dl.phase.Store(3)
		return fmt.Errorf("create %s: %w", dest, err)
	}
	defer out.Close()
	written := int64(0)
	buf := make([]byte, 256*1024)
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				dl.phase.Store(3)
				return fmt.Errorf("write %s: %w", dest, werr)
			}
			written += int64(n)
			if total > 0 {
				dl.percent.Store(written * 100 / total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dl.phase.Store(3)
			return fmt.Errorf("read body: %w", rerr)
		}
	}
	return nil
}

// unzipApp extracts a single .app tree from the zip into destDir.
func unzipApp(zipPath, destDir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".app/") && !strings.Contains(f.Name, ".app/") && filepath.Ext(f.Name) != "" {
			continue
		}
		target := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(target, filepath.Clean(destDir)+string(filepath.Separator)) {
			return fmt.Errorf("非法压缩包路径: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			out.Close()
			rc.Close()
			return err
		}
		out.Close()
		rc.Close()
		if err := os.Chmod(target, f.Mode()); err != nil {
			return err
		}
	}
	return nil
}

// ApplyUpdateRequest carries nothing for now; the target app is fixed.
type ApplyUpdateRequest struct{}

// buildUpdaterScript renders the detached shell script that swaps the running
// app for the staged one and relaunches it (the app quits right after spawn,
// so the script must wait a beat before touching the bundle).
func buildUpdaterScript(stagingDir string) string {
	src := filepath.Join(stagingDir, "dataBasePro.app")
	return fmt.Sprintf(`#!/bin/bash
sleep 1
rm -rf /Applications/dataBasePro.app
ditto "%s" /Applications/dataBasePro.app
open /Applications/dataBasePro.app
`, src)
}

// ApplyUpdate performs the install. macOS: spawn the swap-and-relaunch script
// detached, then quit the current instance. Windows: reveal the downloaded
// zip in Explorer (auto-replace ships later).
func (a *App) ApplyUpdate(_ ApplyUpdateRequest) error {
	if goruntime.GOOS == "windows" {
		p, _ := a.downloadPath.Load().(string)
		if p == "" {
			return fmt.Errorf("尚未下载更新包")
		}
		if err := exec.Command("explorer", "/select,", p).Start(); err != nil {
			return fmt.Errorf("打开下载目录失败: %w", err)
		}
		return nil
	}
	staging, _ := a.stagingDir.Load().(string)
	if staging == "" {
		return fmt.Errorf("尚未下载更新包")
	}
	appSrc := filepath.Join(staging, "dataBasePro.app")
	if _, err := os.Stat(appSrc); err != nil {
		return fmt.Errorf("更新包缺少 dataBasePro.app: %w", err)
	}
	script := filepath.Join(staging, "apply-update.sh")
	if err := os.WriteFile(script, []byte(buildUpdaterScript(staging)), 0o755); err != nil {
		return fmt.Errorf("写入更新脚本失败: %w", err)
	}
	if err := a.apply()(exec.Command("/bin/bash", script)); err != nil {
		return fmt.Errorf("启动更新脚本失败: %w", err)
	}
	if a.ctx != nil {
		runtime.Quit(a.ctx)
	}
	return nil
}// UpdateProgress returns the current download progress for the polling UI.
func (a *App) UpdateProgress() UpdateProgressInfo {
	dl := a.downloadState()
	info := UpdateProgressInfo{
		Phase:   "idle",
		Percent: int(dl.percent.Load()),
	}
	switch dl.phase.Load() {
	case 1:
		info.Phase = "downloading"
	case 2:
		info.Phase = "done"
	case 3:
		info.Phase = "error"
		if e, ok := dl.err.Load().(string); ok {
			info.Error = e
		}
	}
	return info
}

// OpenURL opens a URL in the system browser.
func (a *App) OpenURL(url string) error {
	if a.ctx == nil {
		return fmt.Errorf("应用尚未初始化")
	}
	runtime.BrowserOpenURL(a.ctx, url)
	return nil
}
