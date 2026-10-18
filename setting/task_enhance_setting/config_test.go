package task_enhance_setting

import (
	"math"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

func TestCoefficientFollowsOfficialTables(t *testing.T) {
	cases := []struct {
		version    string
		resolution string
		fps        float64
		want       float64
	}{
		// 官方示例：标准版 1080P/25fps 系数 2；专业版 1080P/25fps 系数 20。
		{"standard", "1080p", 25, 2},
		{"professional", "1080p", 25, 20},
		{"standard", "720p", 24, 1},
		{"standard", "720P", 24, 1},
		{"standard", "1080p", 50, 4},   // 分辨率系数 2 × 帧率系数 2
		{"standard", "1080P", 120, 8},  // 分辨率系数 2 × 帧率系数 4
		{"generative", "720p", 24, 1},  // 大模型版 720P=1
		{"generative", "2k", 24, 4},    // 大模型版 2K=4
		{"fast", "1080p", 24, 2},       // 极速版结构同标准版
		{"standard", "1440p", 24, 4},   // 1440p 归一化到 2K
		{"standard", "2160p", 24, 8},   // 4K
		{"standard", "unknown", 24, 2}, // 认不出按 1080P 计，不 0 收
	}
	for _, c := range cases {
		if got := Coefficient(c.version, c.resolution, c.fps); got != c.want {
			t.Errorf("Coefficient(%s, %s, %v) = %v, want %v", c.version, c.resolution, c.fps, got, c.want)
		}
	}
}

func TestCostAndQuotaFollowBillingFormula(t *testing.T) {
	// 官方示例：8 秒 720P ≤30fps 标准版 = 8/60 分钟 × 1 × 0.75 元/分钟
	if got := CostCNY("standard", "720p", 24, 8); math.Abs(got-0.1) > 1e-9 {
		t.Fatalf("CostCNY = %v, want 0.1", got)
	}
	// 本地额度 = 费用 × Markup ÷ 汇率 × QuotaPerUnit
	rate := operation_setting.USDExchangeRate
	markup := GetCopy().Markup
	want := 0.1 * markup / rate * float64(common.QuotaPerUnit)
	got := QuotaForUsage("standard", "720p", 24, 8)
	if math.Abs(float64(got)-math.Round(want)) > 1 {
		t.Fatalf("QuotaForUsage = %d, want ≈ %.1f", got, want)
	}
	// 无效输入不再收费
	if quota := QuotaForUsage("standard", "720p", 24, 0); quota != 0 {
		t.Errorf("zero duration should cost 0, got %d", quota)
	}
	if quota := QuotaForUsage("unknown-version", "720p", 24, 8); quota != 0 {
		t.Errorf("unknown tool version should cost 0, got %d", quota)
	}
}

func TestMatchRuleHonoursOrderAndExclusions(t *testing.T) {
	original := GetCopy()
	defer func() {
		taskEnhanceSetting.Rules = original.Rules
		taskEnhanceSetting.ExcludeModels = original.ExcludeModels
	}()
	taskEnhanceSetting.Rules = []ModelRule{
		{Models: []string{"SD-2.0-MZ1"}, ToolVersion: "professional", Resolution: "1080p"},
		{Models: []string{"*"}, ToolVersion: "standard", Resolution: "auto"},
	}
	taskEnhanceSetting.ExcludeModels = []string{"sd-2-c4"}

	rule, ok := MatchRule("SD-2.0-MZ1")
	if !ok || rule.ToolVersion != "professional" {
		t.Fatalf("exact rule should win, got %+v ok=%v", rule, ok)
	}
	rule, ok = MatchRule("minimax-h3-quality")
	if !ok || rule.ToolVersion != "standard" {
		t.Fatalf("wildcard rule should match, got %+v ok=%v", rule, ok)
	}
	if _, ok = MatchRule("sd-2-c4"); ok {
		t.Fatal("excluded model must not match")
	}
	if _, ok = MatchRule(""); ok {
		t.Fatal("empty model must not match")
	}
}
