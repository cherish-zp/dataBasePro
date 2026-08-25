package service

import (
	"errors"
	"fmt"
	"sync"
)

// ErrNotConnected is returned when an operation targets a connection id that
// is not currently pooled.
var ErrNotConnected = errors.New("connection is not active")

// Pool holds the currently-established data source instances, keyed by
// connection UUID. It is safe for concurrent use.
type Pool struct {
	mu    sync.RWMutex
	conns map[string]DataSource
}

// NewPool returns an empty connection pool.
func NewPool() *Pool {
	return &Pool{conns: make(map[string]DataSource)}
}

// Put registers (or replaces) a data source under id.
func (p *Pool) Put(id string, ds DataSource) error {
	if id == "" {
		return errors.New("connection id must not be empty")
	}
	if ds == nil {
		return errors.New("data source must not be nil")
	}
	p.mu.Lock()
	p.conns[id] = ds
	p.mu.Unlock()
	return nil
}

// Get returns the data source registered under id.
func (p *Pool) Get(id string) (DataSource, error) {
	p.mu.RLock()
	ds, ok := p.conns[id]
	p.mu.RUnlock()
	if !ok {
		return nil, ErrNotConnected
	}
	return ds, nil
}

// Remove deletes the data source under id and returns it.
func (p *Pool) Remove(id string) (DataSource, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ds, ok := p.conns[id]
	if !ok {
		return nil, ErrNotConnected
	}
	delete(p.conns, id)
	return ds, nil
}

// Len returns the number of pooled connections.
func (p *Pool) Len() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.conns)
}

// CloseAll closes every pooled connection and empties the pool.
func (p *Pool) CloseAll() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var errs []error
	for id, ds := range p.conns {
		if err := ds.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close %s: %w", id, err))
		}
		delete(p.conns, id)
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
