// Command dbclient is a minimal CLI that exercises the backend service
// without Wails, useful for manual verification. The Wails app shell will
// bind the same backend.App methods to the frontend.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"my-db-client/backend"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		fatal(err)
	}
	dbPath := filepath.Join(home, ".db-client", "config.db")
	master := os.Getenv("DB_CLIENT_MASTER")
	if master == "" {
		master = "dbclient-default-master"
	}

	app, closeDB, err := backend.NewDefaultApp(dbPath, master)
	if err != nil {
		fatal(err)
	}
	defer closeDB()

	switch os.Args[1] {
	case "list":
		conns, err := app.ListConnections()
		if err != nil {
			fatal(err)
		}
		if len(conns) == 0 {
			fmt.Println("no connections yet")
		}
		for _, c := range conns {
			fmt.Printf("%s\t%s\t%s\n", c.ID, c.Name, c.Type)
		}
	case "add":
		if len(os.Args) < 4 {
			fail("usage: add <name> <bootstrap.servers>")
		}
		c, err := app.CreateConnection(backend.NewKafkaConnection(os.Args[2], []string{os.Args[3]}))
		if err != nil {
			fatal(err)
		}
		fmt.Printf("created connection %s (%s)\n", c.ID, c.Name)
	case "test":
		if len(os.Args) < 3 {
			fail("usage: test <bootstrap.servers>")
		}
		if err := app.TestConnection(backend.NewKafkaConnection("test", []string{os.Args[2]}).Config); err != nil {
			fatal(err)
		}
		fmt.Println("connection ok")
	case "topics":
		if len(os.Args) < 3 {
			fail("usage: topics <connection-id>")
		}
		topics, err := app.ListTopics(os.Args[2])
		if err != nil {
			fatal(err)
		}
		for _, t := range topics {
			fmt.Printf("%s (partitions=%d)\n", t.Name, len(t.Partitions))
		}
	default:
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Println(`dbclient - Kafka multi-datasource client backend demo

usage:
  dbclient list                         list saved connections
  dbclient add <name> <brokers>         create a connection
  dbclient test <brokers>               ping a broker list
  dbclient topics <connection-id>       list topics of a connection`)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}
