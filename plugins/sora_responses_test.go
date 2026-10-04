package plugins_test

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSoraResponsesProtocol(t *testing.T) {
	testVideoResponsesProtocol(t, videoResponsesTestCase{
		pluginKey: "sora",
		model:     "sora-2-pro",
		requestBody: map[string]any{
			"model":   "sora-2-pro",
			"input":   "waves at sunset",
			"seconds": 8,
			"size":    "1792x1024",
		},
		wantAction: "text_to_video",
		wantRequest: map[string]any{
			"model":   "sora-2-pro",
			"prompt":  "waves at sunset",
			"seconds": float64(8),
			"size":    "1792x1024",
		},
		wantUsageKeys:       []string{"seconds", "size"},
		wantSubmitUsageKeys: []string{"seconds", "size"},
		wantVendorName:      "sora",
	})
}

// 计费口径回归：按次（legacy ratio）读 billing_ratios 时倍率恒为 1，
// 按秒（task 表达式）读 facts 时返回真实时长。历史坑（2026-09-21）就出在这里：
// 客户端多长就放大多少倍，¥5/次 变成 ¥150/次。
func TestSoraUsageSecondsByBillingPurpose(t *testing.T) {
	source, err := builtinplugins.Source("sora")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "sora"})
	require.NoError(t, err)

	cases := []struct {
		name string
		body map[string]any
		want float64
	}{
		{"bridge true value wins over the placeholder", map[string]any{"seconds": "1", "_billing_seconds": 8}, 8},
		{"canvas value without the bridge field", map[string]any{"seconds": 30}, 30},
		{"placeholder only stays at one second", map[string]any{"seconds": "1"}, 1},
		{"metadata carries the true duration", map[string]any{"seconds": "1", "metadata": map[string]any{"seconds": 12}}, 12},
		{"duration above the task ceiling is bounded", map[string]any{"seconds": 99999}, 3600},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			for _, purpose := range []struct {
				name       string
				usage      string
				wantSecond float64
			}{
				{"facts", "facts", testCase.want},
				{"billing_ratios", "billing_ratios", 1},
			} {
				ctx := map[string]any{
					"model":         "seedance_v2.5",
					"upstreamModel": "seedance_v2.5",
					"action":        "text_to_video",
					"requestBody":   testCase.body,
					"usagePurpose":  purpose.usage,
				}
				value, callErr := plugin.Engine.Call(t.Context(), "extractUsage", ctx)
				require.NoError(t, callErr, purpose.name)
				encoded, marshalErr := common.Marshal(value)
				require.NoError(t, marshalErr)
				var facts map[string]any
				require.NoError(t, common.Unmarshal(encoded, &facts))
				assert.Equal(t, purpose.wantSecond, facts["seconds"], "%s/%s", testCase.name, purpose.name)
			}
		})
	}
}
