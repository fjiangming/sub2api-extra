'use strict';

function demoFingerprintResponse(model, platform, config = {}) {
  const parameters = { api: platform === 'anthropic' ? 'messages' : 'responses', effort: 'high', rounds: 3, count: 3, parallel: 1, strict: false, ...Object.fromEntries(Object.entries(config).filter(([key]) => ['api', 'effort', 'rounds', 'count', 'parallel', 'strict'].includes(key))) };
  const models = [model, platform === 'anthropic' ? 'claude-opus-4.6' : 'gpt-5.5', 'gpt-5.4', 'claude-sonnet-4.6', 'gemini-3.1-pro-preview', 'deepseek-v3.2'];
  const rounds = Array.from({ length: parameters.rounds }, (_, index) => {
    const samples = Array.from({ length: parameters.count }, (_, number) => {
      const expected = 300 + number * 7;
      const text = Array.from({ length: expected }, (_value, n) => 1 + ((n * 137 + index * 29 + number * 43) % 355)).join(', ');
      return { state: 'complete', text, raw_text: text, count: expected, expected_count: expected, first_byte_ms: 480, response_model: model, error: null, prompt: `演示挑战：请输出 ${expected} 个 1 到 355 之间的整数。` };
    });
    const partial = parameters.count < 3;
    const analysis = { decision: partial ? 'partial' : 'scored', prediction: model, prediction_name: model,
      family_prediction: platform === 'anthropic' ? 'claude' : 'gpt', probability: partial ? null : 0.82,
      probability_status: partial ? 'unavailable' : 'reference_calibrated', probability_scope: partial ? null : 'reference_bank_only',
      used_outputs: parameters.count, ranking_score: 2.84,
      results: models.map((name, i) => ({ model: name, display_name: name, family: name.split('-')[0], score: [2.84, 1.42, 0.51, -0.33, -0.81, -1.24][i], probability: partial ? null : [0.82, 0.1, 0.04, 0.02, 0.01, 0.01][i] })),
      diagnostics: samples.map(sample => ({ parsed_numbers: sample.count, minimum_numbers: Math.ceil(sample.count * 0.55), accepted: true, raw_out_of_range_count: 0 })),
      sequence: { autocorrelation: -0.42, small_step_share: 0.025, model_like: true }, evidence: { label: '模拟候选排序', reason: '演示数据，不代表实际模型鉴定。' } };
    return { round: index + 1, samples, challenges: samples.map((sample, i) => ({ id: `demo-${index}-${i}`, prompt: sample.prompt, expected_count: sample.expected_count })), analysis, error: null };
  });
  return { engine: 'fingerpoint', status: 'done', requested_model: model, sdk_version: require('../package.json').dependencies['lmfpd-sdk'], data: { built_at: '2026-11-03T12:06:39.864Z', hash: '59dffad8128dca8bcf0cfb024f0fcebe7f0b7d7fbae3583b4b5d1418c18e601f', models: 66 }, parameters, rounds, analysis: rounds.at(-1).analysis, verdictKey: parameters.count < 3 ? 'partial' : 'candidate_match', progress: 1 };
}

module.exports = { demoFingerprintResponse };
