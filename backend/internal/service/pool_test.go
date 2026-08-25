package service

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

type fakeDataSource struct {
	name   string
	conns  int
	closed bool
	mu     sync.Mutex
}

func (f *fakeDataSource) Connect(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conns++
	return nil
}

func (f *fakeDataSource) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeDataSource) GetName() string { return f.name }
func (f *fakeDataSource) GetType() string { return "kafka" }

func TestPoolPutGet(t *testing.T) {
	p := NewPool()
	ds := &fakeDataSource{name: "local"}
	if err := p.Put("conn-1", ds); err != nil {
		t.Fatalf("Put failed: %v", err)
	}
	got, err := p.Get("conn-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got != DataSource(ds) {
		t.Fatal("Get must return the same instance that was Put")
	}
	if p.Len() != 1 {
		t.Fatalf("Len = %d, want 1", p.Len())
	}
}

func TestPoolGetMissing(t *testing.T) {
	p := NewPool()
	if _, err := p.Get("nope"); err == nil {
		t.Fatal("Get on a missing key must fail")
	}
}

func TestPoolPutDuplicateReplaces(t *testing.T) {
	p := NewPool()
	ds1 := &fakeDataSource{name: "a"}
	ds2 := &fakeDataSource{name: "b"}
	if err := p.Put("conn-1", ds1); err != nil {
		t.Fatalf("Put 1 failed: %v", err)
	}
	if err := p.Put("conn-1", ds2); err != nil {
		t.Fatalf("Put 2 failed: %v", err)
	}
	if p.Len() != 1 {
		t.Fatalf("Len = %d, want 1 after replace", p.Len())
	}
	got, _ := p.Get("conn-1")
	if got != DataSource(ds2) {
		t.Fatal("Put must replace the previous instance")
	}
}

func TestPoolRemove(t *testing.T) {
	p := NewPool()
	ds := &fakeDataSource{name: "a"}
	_ = p.Put("conn-1", ds)
	removed, err := p.Remove("conn-1")
	if err != nil {
		t.Fatalf("Remove failed: %v", err)
	}
	if removed != DataSource(ds) {
		t.Fatal("Remove must return the removed instance")
	}
	if p.Len() != 0 {
		t.Fatalf("Len = %d, want 0", p.Len())
	}
	if _, err := p.Get("conn-1"); err == nil {
		t.Fatal("removed key must be gone")
	}
}

func TestPoolRemoveMissing(t *testing.T) {
	p := NewPool()
	if _, err := p.Remove("nope"); err == nil {
		t.Fatal("Remove on a missing key must fail")
	}
}

func TestPoolCloseAll(t *testing.T) {
	p := NewPool()
	ds1 := &fakeDataSource{name: "a"}
	ds2 := &fakeDataSource{name: "b"}
	_ = p.Put("1", ds1)
	_ = p.Put("2", ds2)
	if err := p.CloseAll(); err != nil {
		t.Fatalf("CloseAll failed: %v", err)
	}
	if !ds1.closed || !ds2.closed {
		t.Fatal("CloseAll must close every pooled connection")
	}
}

func TestPoolConcurrentAccess(t *testing.T) {
	p := NewPool()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_ = p.Put(id, &fakeDataSource{name: id})
			_, _ = p.Get(id)
			_ = p.Len()
		}(fmt.Sprintf("c%d", i))
	}
	wg.Wait()
	if p.Len() != 50 {
		t.Fatalf("Len = %d, want 50", p.Len())
	}
}
