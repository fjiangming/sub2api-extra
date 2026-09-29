'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('cheerio');
const {
  MAX_GEOMETRY_OPERATIONS,
  createSvgMathEvaluator,
  parseTransform
} = require('../src/svg-math');

const scene = `<!doctype html><html><body>
  <svg viewBox="0 0 240 180">
    <circle id="front-wheel" cx="170" cy="120" r="40">
      <animateTransform attributeName="transform" type="rotate" values="0 170 120;360 170 120" />
    </circle>
    <circle id="rear-wheel" cx="70" cy="120" r="40" />
    <g id="rider" data-anchor-x="110" data-anchor-y="60" data-bbox="50 20 120 120">
      <animateTransform attributeName="transform" type="translate" values="0 0;20 0;0 0" />
      <circle id="left-foot" cx="116" cy="102" r="3" />
      <circle id="left-pedal" cx="119" cy="102" r="3" />
    </g>
  </svg>
</body></html>`;

function evaluator(source = scene) {
  return createSvgMathEvaluator(load(source), source, { samples: 12, pass_ratio: 0.9 });
}

test('SVG math evaluates sampled distance, alignment, containment, movement, rotation, and loops', () => {
  const math = evaluator();
  const evaluate = (geometry_operation, source_selector, geometry_threshold, extra = {}) => math.evaluate({
    geometry_operation, source_selector, geometry_threshold, ...extra
  });

  assert.equal(evaluate('distance_lte', '#left-foot', 0.1, {
    target_selector: '#left-pedal', reference_selector: '#front-wheel'
  }).passed, true);
  assert.equal(evaluate('aligned_y', '#front-wheel', 0, { target_selector: '#rear-wheel' }).passed, true);
  assert.equal(evaluate('inside_viewbox', '#rider', 0).passed, true);
  assert.equal(evaluate('motion_gte', '#rider', 15).passed, true);
  assert.equal(evaluate('motion_gte', '#rider', 15, { target_selector: '#missing' }).passed, true);
  assert.equal(evaluate('rotation_gte', '#front-wheel', 300).passed, true);
  assert.equal(evaluate('loop_distance_lte', '#rider', 0).passed, true);

  const tooFar = evaluate('distance_lte', '#left-foot', 0.05, {
    target_selector: '#left-pedal', reference_selector: '#front-wheel'
  });
  assert.equal(tooFar.passed, false);
  assert.equal(tooFar.indeterminate, false);
  assert.match(tooFar.message, /最大观测值 3/);
});

test('SVG math fails closed when deterministic source geometry is unavailable', () => {
  const scripted = evaluator('<svg viewBox="0 0 10 10"><script>setInterval(() => {}, 1)</script><circle id="point" cx="1" cy="1" r="1" /></svg>');
  assert.deepEqual(scripted.evaluate({
    geometry_operation: 'inside_viewbox', source_selector: '#point', geometry_threshold: 0
  }), {
    passed: false,
    indeterminate: true,
    message: '检测到脚本；SVG 数学检测只支持声明式动画'
  });

  const ambiguous = evaluator();
  const result = ambiguous.evaluate({
    geometry_operation: 'inside_viewbox', source_selector: 'circle', geometry_threshold: 0
  });
  assert.equal(result.indeterminate, true);
  assert.match(result.message, /精确匹配 1 个元素/);

  const missingTarget = ambiguous.evaluate({
    geometry_operation: 'distance_lte', source_selector: '#left-foot', geometry_threshold: 1
  });
  assert.equal(missingTarget.indeterminate, true);
  assert.match(missingTarget.message, /缺少目标元素选择器/);

  const foreignObject = evaluator('<svg viewBox="0 0 10 10"><foreignObject id="point" x="1" y="1" width="2" height="2" /></svg>');
  assert.match(foreignObject.evaluate({
    geometry_operation: 'inside_viewbox', source_selector: '#point', geometry_threshold: 0
  }).message, /foreignObject/);

  const unsupportedMotion = evaluator('<svg viewBox="0 0 10 10"><circle id="point" cx="1" cy="1" r="1"><animateMotion path="M0 0 L5 0" /></circle></svg>');
  assert.match(unsupportedMotion.evaluate({
    geometry_operation: 'motion_gte', source_selector: '#point', geometry_threshold: 1
  }).message, /animateMotion/);
});

test('SVG transform parsing composes standard affine transforms', () => {
  assert.deepEqual(parseTransform('translate(10 20) scale(2)'), [2, 0, 0, 2, 10, 20]);
  assert.throws(() => parseTransform('translate(calc(1px))'), /无法解析/);
});

test('SVG math bounds worst-case geometry work instead of blocking indefinitely', () => {
  const samples = 24;
  const shapeCount = Math.ceil(MAX_GEOMETRY_OPERATIONS / (samples * 2)) + 100;
  const shapes = Array.from({ length: shapeCount }, (_item, index) =>
    `<circle cx="${index % 100}" cy="${Math.floor(index / 100)}" r="1"/>`).join('');
  const source = `<svg viewBox="0 0 1000 1000"><g id="scene">${shapes}</g></svg>`;
  const result = createSvgMathEvaluator(load(source), source, {
    samples, pass_ratio: 0.9
  }).evaluate({
    geometry_operation: 'inside_viewbox', source_selector: '#scene', geometry_threshold: 0
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.message, /资源上限/);
});
