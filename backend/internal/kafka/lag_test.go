package kafka

import (
	"reflect"
	"testing"

	"github.com/twmb/franz-go/pkg/kadm"

	"dataBasePro/backend/internal/model"
)

func TestMapPartitionLagIncludesMember(t *testing.T) {
	m := kadm.GroupMemberLag{
		Topic:     "t1",
		Partition: 3,
		Commit:    kadm.Offset{At: 10},
		End:       kadm.ListedOffset{Offset: 25},
		Lag:       15,
		Member: &kadm.DescribedGroupMember{
			MemberID:   "m-1",
			ClientID:   "c-1",
			ClientHost: "10.0.0.1",
		},
	}
	got := mapPartitionLag(m)
	want := model.PartitionLag{
		Partition:  3,
		Current:    10,
		LogEnd:     25,
		Lag:        15,
		MemberID:   "m-1",
		ClientID:   "c-1",
		ClientHost: "10.0.0.1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapPartitionLag mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestMapPartitionLagNilMemberLeavesMemberFieldsEmpty(t *testing.T) {
	m := kadm.GroupMemberLag{
		Partition: 0,
		Commit:    kadm.Offset{At: 5},
		End:       kadm.ListedOffset{Offset: 8},
		Lag:       3,
	}
	got := mapPartitionLag(m)
	if got.MemberID != "" || got.ClientID != "" || got.ClientHost != "" {
		t.Fatalf("expected empty member fields for nil member, got %+v", got)
	}
}
