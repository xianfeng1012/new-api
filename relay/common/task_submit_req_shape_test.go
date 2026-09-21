package common

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
)

func shapeBoolPtr(v bool) *bool { return &v }
func shapeIntPtr(v int) *int    { return &v }

// 画布类客户端对同一字段的形状并不统一（bool/string/number 混着来）。
// 这里把解析层的宽容度钉死：形状再怪也只影响取值，不该让整个请求 400。
func TestTaskSubmitReqAcceptsCanvasFieldShapes(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantAudio    *bool
		wantCount    *int
		wantSeconds  string
		wantDuration int
	}{
		{"原生布尔 true", `{"generate_audio":true}`, shapeBoolPtr(true), nil, "", 0},
		{"原生布尔 false", `{"generate_audio":false}`, shapeBoolPtr(false), nil, "", 0},
		{"字符串 true", `{"generate_audio":"true"}`, shapeBoolPtr(true), nil, "", 0},
		{"字符串 TRUE", `{"generate_audio":"TRUE"}`, shapeBoolPtr(true), nil, "", 0},
		{"字符串 1", `{"generate_audio":"1"}`, shapeBoolPtr(true), nil, "", 0},
		{"数字 1", `{"generate_audio":1}`, shapeBoolPtr(true), nil, "", 0},
		{"字符串 是", `{"generate_audio":"是"}`, shapeBoolPtr(true), nil, "", 0},
		{"字符串 false", `{"generate_audio":"false"}`, shapeBoolPtr(false), nil, "", 0},
		{"字符串 0", `{"generate_audio":"0"}`, shapeBoolPtr(false), nil, "", 0},
		{"数字 0", `{"generate_audio":0}`, shapeBoolPtr(false), nil, "", 0},
		{"字符串 否", `{"generate_audio":"否"}`, shapeBoolPtr(false), nil, "", 0},
		{"缺省不落 nil 之外的默认", `{"prompt":"x"}`, nil, nil, "", 0},
		{"count 字符串", `{"count":"3"}`, nil, shapeIntPtr(3), "", 0},
		{"count 数字", `{"count":3}`, nil, shapeIntPtr(3), "", 0},
		{"seconds 数字", `{"seconds":15}`, nil, nil, "15", 0},
		{"seconds 字符串", `{"seconds":"15"}`, nil, nil, "15", 0},
		{"duration 数字", `{"duration":15}`, nil, nil, "", 15},
		{"duration 字符串", `{"duration":"15"}`, nil, nil, "", 15},
		{"画布混合形状", `{"generate_audio":"true","count":"1","seconds":15,"duration":"15"}`,
			shapeBoolPtr(true), shapeIntPtr(1), "15", 15},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req TaskSubmitReq
			err := common.Unmarshal([]byte(tc.raw), &req)
			assert.NoError(t, err)
			if tc.wantAudio == nil {
				assert.Nil(t, req.GenerateAudio)
			} else {
				assert.NotNil(t, req.GenerateAudio)
				assert.Equal(t, *tc.wantAudio, *req.GenerateAudio)
			}
			if tc.wantCount == nil {
				assert.Nil(t, req.Count)
			} else {
				assert.NotNil(t, req.Count)
				assert.Equal(t, *tc.wantCount, *req.Count)
			}
			assert.Equal(t, tc.wantSeconds, req.Seconds)
			assert.Equal(t, tc.wantDuration, req.Duration)
		})
	}
}
