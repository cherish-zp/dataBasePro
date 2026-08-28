package kafka

import (
	"context"
	"reflect"
	"testing"

	"github.com/twmb/franz-go/pkg/kadm"

	"dataBasePro/backend/internal/model"
)

func TestMapGroupDetailBuildsMemberTopology(t *testing.T) {
	dg := kadm.DescribedGroup{
		Group:        "grp-1",
		State:        "Stable",
		ProtocolType: "consumer",
		Members: []kadm.DescribedGroupMember{
			{MemberID: "m-1", ClientID: "c-1", ClientHost: "/10.0.0.1"},
			{MemberID: "m-2", ClientID: "c-2", ClientHost: "/10.0.0.2"},
		},
	}
	got := mapGroupDetail("grp-1", dg)
	want := &model.GroupDetail{
		Group:        "grp-1",
		State:        "Stable",
		ProtocolType: "consumer",
		Members: []model.GroupMember{
			{MemberID: "m-1", ClientID: "c-1", Host: "/10.0.0.1", Assignment: map[string][]int32{}},
			{MemberID: "m-2", ClientID: "c-2", Host: "/10.0.0.2", Assignment: map[string][]int32{}},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapGroupDetail mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestMapGroupDetailKeepsGroupFieldsWithoutMembers(t *testing.T) {
	got := mapGroupDetail("grp-2", kadm.DescribedGroup{Group: "grp-2", State: "Empty", ProtocolType: "consumer"})
	if got.Members == nil {
		t.Fatal("members must be an empty array, not null")
	}
	if len(got.Members) != 0 {
		t.Fatalf("expected no members, got %+v", got.Members)
	}
	if got.Group != "grp-2" || got.State != "Empty" || got.ProtocolType != "consumer" {
		t.Fatalf("unexpected group fields: %+v", got)
	}
}

func TestMapGroupMembersSortsTopicsAndPartitions(t *testing.T) {
	members := []consumerAssignment{
		{
			MemberID:   "m-1",
			ClientID:   "c-1",
			ClientHost: "10.0.0.1",
			topics:     map[string][]int32{"t2": {3, 1}, "t1": {9, 0}},
		},
	}
	got := mapGroupMembers(members)
	want := []model.GroupMember{
		{
			MemberID:   "m-1",
			ClientID:   "c-1",
			Host:       "10.0.0.1",
			Assignment: map[string][]int32{"t1": {0, 9}, "t2": {1, 3}},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapGroupMembers mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestMapGroupMembersNeverReturnsNull(t *testing.T) {
	got := mapGroupMembers(nil)
	if got == nil {
		t.Fatal("mapGroupMembers must return an empty array, not null")
	}
	if len(got) != 0 {
		t.Fatalf("expected no members, got %+v", got)
	}
}

// TestDescribeGroupUnknownGroupOnFakeCluster pins the tolerant behaviour for a
// group that does not exist: no error, group name echoed back, empty members.
func TestDescribeGroupUnknownGroupOnFakeCluster(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)
	detail, err := cl.DescribeGroup(context.Background(), "no-such-group")
	if err != nil {
		t.Fatalf("DescribeGroup: %v", err)
	}
	if detail.Group != "no-such-group" {
		t.Fatalf("expected group name echoed back, got %+v", detail)
	}
	if detail.Members == nil || len(detail.Members) != 0 {
		t.Fatalf("expected empty (non-nil) members, got %+v", detail.Members)
	}
}
