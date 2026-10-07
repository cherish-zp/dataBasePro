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
	updateRepo           = "sheng-shou-yun-he"
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

// pickAssetURL selects the release asset for the current OS+arch. 发布流水线
// 的资产命名形如 圣手运河-v1.6.0-darwin-arm64.zip:先精确匹配
// "<goos>-<goarch>",上游只提供单一架构包时按 "<goos>" 兜底;源码包
// (不含平台名)永不被选中。
func pickAssetURL(rel giteeRelease, goos, goarch string) string {
	exact := goos + "-" + goarch
	fallback := ""
	for _, a := range rel.Assets {
		name := strings.ToLower(a.Name)
		if a.BrowserDownloadURL == "" {
			continue
		}
		if strings.Contains(name, exact) {
			return a.BrowserDownloadURL
		}
		if fallback == "" && strings.Contains(name, goos) {
			fallback = a.BrowserDownloadURL
		}
	}
	return fallback
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

// 平台探测可注入:测试替换为 darwin/windows 与目标架构。
var (
	runtimeGOOS   = goruntime.GOOS
	runtimeGOARCH = goruntime.GOARCH
)

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
		res.DownloadURL = pickAssetURL(rel, runtimeGOOS, runtimeGOARCH)
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

// DownloadUpdate fetches the release asset into a private staging dir and
// unpacks the payload: macOS zips carry a 圣手运河.app tree, Windows zips
// the payload exe. 安装位置由 ApplyUpdate 决定(原位替换),与下载无关。
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

	staging := filepath.Join(os.TempDir(), fmt.Sprintf("sheng-shou-yun-he-update-%d", time.Now().UnixNano()))
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
	if err := unzipUpdate(zipPath, staging); err != nil {
		dl.phase.Store(3)
		dl.err.Store(fmt.Sprintf("解压更新包失败: %v", err))
		return err
	}
	// 校验暂存产物完整:macOS 要求 .app 树,Windows 要求 exe。
	if runtimeGOOS == "windows" {
		if _, err := findStagedExe(staging); err != nil {
			dl.phase.Store(3)
			dl.err.Store("更新包缺少 圣手运河.exe")
			return err
		}
	} else if _, err := os.Stat(filepath.Join(staging, "圣手运河.app")); err != nil {
		dl.phase.Store(3)
		dl.err.Store("更新包缺少 圣手运河.app")
		return err
	}
	a.stagingDir.Store(staging)
	dl.phase.Store(2)
	dl.percent.Store(100)
	return nil
}

// findStagedExe locates the payload exe in the staging dir: root
// 圣手运河.exe first, then the first *.exe found by depth-first walk.
func findStagedExe(staging string) (string, error) {
	root := filepath.Join(staging, "圣手运河.exe")
	if _, err := os.Stat(root); err == nil {
		return root, nil
	}
	found := ""
	err := filepath.WalkDir(staging, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if found == "" && !d.IsDir() && strings.EqualFold(filepath.Ext(path), ".exe") {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("暂存目录中没有 exe: %s", staging)
	}
	return found, nil
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

// unzipUpdate extracts every entry from the release zip into destDir
// (macOS 包内是 .app 树,Windows 包内是 payload exe),拒绝 zip-slip 路径。
func unzipUpdate(zipPath, destDir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
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

// ApplyUpdateRequest carries nothing for now; the install target is the
// running app's own location.
type ApplyUpdateRequest struct{}

// bundleFromExe 反查运行中可执行文件所属的 .app 包目录(装在哪就更新哪):
// .../Foo.app/Contents/MacOS/bin → .../Foo.app。非 .app 形态(如 go run 的
// 临时二进制)返回错误,由调用方拒绝安装。
func bundleFromExe(exe string) (string, error) {
	dir := filepath.Dir(filepath.Clean(exe))
	for i := 0; i < 3; i++ {
		if strings.HasSuffix(dir, ".app") {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("无法从可执行文件定位 .app 包: %s", exe)
}

// exePath 可注入:测试替换为受控路径。
var exePath = os.Executable

// buildUpdaterScript renders the detached shell script that swaps the running
// install for the staged one, in place, and relaunches it. 原位替换语义:
// 旧包整体改名留作备份(同卷 mv 原子且瞬时),新包复制到原位置,新进程
// 起来后清理备份,任一步失败自动还原旧包——不允许出现「旧版已删、新版
// 没装上」的中间态。脚本在应用退出后由系统继续执行,故先等待退出。
func buildUpdaterScript(stagingDir, target string) string {
	src := filepath.Join(stagingDir, "圣手运河.app")
	return fmt.Sprintf(`#!/bin/bash
SRC="%s"
TARGET="%s"
BACKUP="%s.old"
sleep 2
if mv "$TARGET" "$BACKUP"; then
  if ditto "$SRC" "$TARGET"; then
    open "$TARGET"
    sleep 3
    if pgrep -x 圣手运河 >/dev/null 2>&1; then
      rm -rf "$BACKUP"
    else
      rm -rf "$TARGET"
      mv "$BACKUP" "$TARGET"
      open "$TARGET"
    fi
  else
    mv "$BACKUP" "$TARGET"
    open "$TARGET"
  fi
fi
`, src, target, target)
}

// buildWindowsUpdaterScript renders the detached batch script for Windows.
// 运行中的 exe 不能覆盖但可以改名:旧 exe 原地改名备份 → 新 exe 复制回
// 原路径 → start 重启 → 清理备份;复制失败立即还原。等待用 ping(非交互
// 环境下 timeout 不可用)。
func buildWindowsUpdaterScript(stagingDir, target string) string {
	// Windows 路径强制反斜杠拼接:跨平台构建时 filepath.Join 会产出
	// "C:\stage/圣手运河.exe" 这类混合分隔符,cmd 会把 / 当参数开关。
	src := strings.TrimRight(stagingDir, `/\`) + `\圣手运河.exe`
	return strings.Join([]string{
		`@echo off`,
		// cmd 默认按系统码页解析批处理内容,脚本里出现中文 exe 名(圣手运河.exe),
		// 必须先切 UTF-8 代码页,否则 move/copy/start 的中文路径会乱码。
		`chcp 65001 >nul`,
		`ping -n 3 127.0.0.1 >nul`,
		fmt.Sprintf(`move /Y "%s" "%s.old"`, target, target),
		`if errorlevel 1 exit /b 1`,
		fmt.Sprintf(`copy /Y "%s" "%s"`, src, target),
		`if errorlevel 1 (`,
		fmt.Sprintf(`  move /Y "%s.old" "%s"`, target, target),
		`  exit /b 1`,
		`)`,
		fmt.Sprintf(`start "" "%s"`, target),
		`ping -n 4 127.0.0.1 >nul`,
		fmt.Sprintf(`del "%s.old"`, target),
		"",
	}, "\r\n")
}

// ApplyUpdate performs the install, in place, from the staged payload:
// spawn the platform swap-and-relaunch script detached (它等待本进程退出后
// 动手), then quit the current instance.
func (a *App) ApplyUpdate(_ ApplyUpdateRequest) error {
	staging, _ := a.stagingDir.Load().(string)
	if staging == "" {
		return fmt.Errorf("尚未下载更新包")
	}
	self, err := exePath()
	if err != nil {
		return fmt.Errorf("定位当前程序失败: %w", err)
	}
	var script string
	var cmd *exec.Cmd
	if runtimeGOOS == "windows" {
		if _, err := findStagedExe(staging); err != nil {
			return fmt.Errorf("更新包缺少 圣手运河.exe: %w", err)
		}
		script = filepath.Join(staging, "apply-update.bat")
		if err := os.WriteFile(script, []byte(buildWindowsUpdaterScript(staging, filepath.Clean(self))), 0o755); err != nil {
			return fmt.Errorf("写入更新脚本失败: %w", err)
		}
		cmd = exec.Command("cmd", "/c", script)
	} else {
		appSrc := filepath.Join(staging, "圣手运河.app")
		if _, err := os.Stat(appSrc); err != nil {
			return fmt.Errorf("更新包缺少 圣手运河.app: %w", err)
		}
		target, err := bundleFromExe(self)
		if err != nil {
			return err
		}
		script = filepath.Join(staging, "apply-update.sh")
		if err := os.WriteFile(script, []byte(buildUpdaterScript(staging, target)), 0o755); err != nil {
			return fmt.Errorf("写入更新脚本失败: %w", err)
		}
		cmd = exec.Command("/bin/bash", script)
	}
	if err := a.apply()(cmd); err != nil {
		return fmt.Errorf("启动更新脚本失败: %w", err)
	}
	if a.ctx != nil {
		runtime.Quit(a.ctx)
	}
	return nil
} // UpdateProgress returns the current download progress for the polling UI.
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
