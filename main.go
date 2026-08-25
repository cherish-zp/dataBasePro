// Command dataBasePro is the Wails desktop app entry point. It binds the
// backend.App (backend package) to the frontend. A CLI demo lives in
// cmd/dbclient for non-GUI verification.
package main

import (
	"context"
	"embed"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"dataBasePro/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatal(err)
	}
	dbPath := filepath.Join(home, ".db-client", "config.db")
	master := os.Getenv("DB_CLIENT_MASTER")
	if master == "" {
		master = "dbclient-default-master"
	}

	app, closeDB, err := backend.NewDefaultApp(dbPath, master)
	if err != nil {
		log.Fatal(err)
	}
	defer closeDB()

	err = wails.Run(&options.App{
		Title:  "dataBasePro",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        func(ctx context.Context) {},
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
