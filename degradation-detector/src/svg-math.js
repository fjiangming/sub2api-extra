'use strict';

const MAX_SVG_NODES = 10000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_GEOMETRY_OPERATIONS = 50000;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const SKIPPED_TAGS = new Set([
  'animate', 'animatemotion', 'animatetransform', 'defs', 'desc', 'metadata',
  'script', 'style', 'title'
]);

class SvgMathError extends Error {}

function elementName(node) {
  return String(node?.name || node?.tagName || '').toLowerCase();
}

function attribute(node, name) {
  const attributes = node?.attribs || {};
  if (Object.prototype.hasOwnProperty.call(attributes, name)) return attributes[name];
  const key = Object.keys(attributes).find((item) => item.toLowerCase() === name.toLowerCase());
  return key == null ? undefined : attributes[key];
}

function numberList(value, limit = 512) {
  const tokens = String(value ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length > limit) throw new SvgMathError(`数值数量超过 ${limit} 个的计算上限`);
  const values = tokens.map(Number);
  if (values.length === 0 || values.some((item) => !Number.isFinite(item))) {
    throw new SvgMathError(`无法解析数值“${String(value ?? '').slice(0, 80)}”`);
  }
  return values;
}

function svgNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim();
  if (raw.endsWith('%')) throw new SvgMathError('暂不支持百分比 SVG 坐标');
  const match = raw.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?$/i);
  if (!match) throw new SvgMathError(`无法解析 SVG 坐标“${raw.slice(0, 80)}”`);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) throw new SvgMathError(`SVG 坐标不是有限数字“${raw.slice(0, 80)}”`);
  return parsed;
}

function multiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function applyMatrix(matrix, point) {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]
  };
}

function translation(x, y) {
  return [1, 0, 0, 1, x, y];
}

function rotation(degrees, centerX = 0, centerY = 0) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotated = [cosine, sine, -sine, cosine, 0, 0];
  return multiply(multiply(translation(centerX, centerY), rotated), translation(-centerX, -centerY));
}

function transformMatrix(type, values) {
  switch (String(type || '').toLowerCase()) {
    case 'matrix':
      if (values.length !== 6) throw new SvgMathError('matrix() 必须包含 6 个数值');
      return values;
    case 'translate':
      if (![1, 2].includes(values.length)) throw new SvgMathError('translate() 必须包含 1 或 2 个数值');
      return translation(values[0], values[1] || 0);
    case 'scale': {
      if (![1, 2].includes(values.length)) throw new SvgMathError('scale() 必须包含 1 或 2 个数值');
      const y = values.length === 2 ? values[1] : values[0];
      return [values[0], 0, 0, y, 0, 0];
    }
    case 'rotate':
      if (![1, 3].includes(values.length)) throw new SvgMathError('rotate() 必须包含 1 或 3 个数值');
      return rotation(values[0], values[1] || 0, values[2] || 0);
    case 'skewx':
      if (values.length !== 1) throw new SvgMathError('skewX() 必须包含 1 个数值');
      return [1, 0, Math.tan(values[0] * Math.PI / 180), 1, 0, 0];
    case 'skewy':
      if (values.length !== 1) throw new SvgMathError('skewY() 必须包含 1 个数值');
      return [1, Math.tan(values[0] * Math.PI / 180), 0, 1, 0, 0];
    default:
      throw new SvgMathError(`不支持 SVG 变换 ${type || '未知类型'}`);
  }
}

function parseTransform(value) {
  const source = String(value || '').trim();
  if (!source) return IDENTITY;
  const expression = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let matrix = IDENTITY;
  let match;
  let consumed = 0;
  while ((match = expression.exec(source))) {
    if (source.slice(consumed, match.index).replace(/[\s,]+/g, '')) {
      throw new SvgMathError('SVG transform 包含无法解析的内容');
    }
    matrix = multiply(matrix, transformMatrix(match[1], numberList(match[2])));
    consumed = expression.lastIndex;
  }
  if (consumed === 0 || source.slice(consumed).replace(/[\s,]+/g, '')) {
    throw new SvgMathError('SVG transform 无法解析');
  }
  return matrix;
}

function childElements(node, expectedName = '') {
  return (node?.children || []).filter((child) => {
    if (!child || !['tag', 'script', 'style'].includes(child.type)) return false;
    return !expectedName || elementName(child) === expectedName;
  });
}

function animationFor(node, tagName, attributeName) {
  const matching = childElements(node, tagName).filter((child) =>
    String(attribute(child, 'attributeName') || '').toLowerCase() === attributeName.toLowerCase());
  if (matching.length > 1) throw new SvgMathError(`元素包含多个 ${attributeName} 动画，无法确定性计算`);
  return matching[0] || null;
}

function interpolateValues(animation, progress, baseValues) {
  const mode = String(attribute(animation, 'calcMode') || 'linear').toLowerCase();
  if (!['linear', 'discrete'].includes(mode)) {
    throw new SvgMathError(`暂不支持 calcMode="${mode}"`);
  }
  let values;
  const configuredValues = attribute(animation, 'values');
  if (configuredValues) {
    const segments = String(configuredValues).split(';');
    if (segments.length > 256) throw new SvgMathError('动画关键值超过 256 个的计算上限');
    values = segments.map((value) => numberList(value));
  } else {
    const from = attribute(animation, 'from');
    const to = attribute(animation, 'to');
    const by = attribute(animation, 'by');
    const start = from == null ? baseValues : numberList(from);
    if (to != null) {
      values = [start, numberList(to)];
    } else if (by != null) {
      const delta = numberList(by);
      if (delta.length !== start.length) throw new SvgMathError('动画 from/by 数值数量不一致');
      values = [start, start.map((item, index) => item + delta[index])];
    } else {
      throw new SvgMathError('动画必须配置 values、to 或 by');
    }
  }
  if (values.length < 2 || values.some((item) => item.length !== values[0].length)) {
    throw new SvgMathError('动画关键值数量不一致');
  }
  let keyTimes;
  if (attribute(animation, 'keyTimes')) {
    keyTimes = numberList(attribute(animation, 'keyTimes'));
    if (keyTimes.length !== values.length || keyTimes[0] !== 0 || keyTimes.at(-1) !== 1) {
      throw new SvgMathError('动画 keyTimes 必须与 values 对应，并从 0 到 1');
    }
  } else {
    keyTimes = values.map((_item, index) => index / (values.length - 1));
  }
  const clamped = Math.max(0, Math.min(1, progress));
  let segment = keyTimes.length - 2;
  for (let index = 0; index < keyTimes.length - 1; index += 1) {
    if (clamped <= keyTimes[index + 1]) {
      segment = index;
      break;
    }
  }
  const span = keyTimes[segment + 1] - keyTimes[segment];
  const ratio = span <= 0 ? 0 : (clamped - keyTimes[segment]) / span;
  if (mode === 'discrete') return values[segment];
  return values[segment].map((item, index) => item + (values[segment + 1][index] - item) * ratio);
}

function animatedNumber(node, name, progress, fallback = 0) {
  const base = svgNumber(attribute(node, name), fallback);
  const animation = animationFor(node, 'animate', name);
  if (!animation) return base;
  const values = interpolateValues(animation, progress, [base]);
  if (values.length !== 1) throw new SvgMathError(`${name} 动画只能包含单个数值`);
  return values[0];
}

function localMatrix(node, progress) {
  const base = parseTransform(attribute(node, 'transform'));
  const animation = animationFor(node, 'animatetransform', 'transform');
  if (!animation) return base;
  if (String(attribute(animation, 'accumulate') || 'none').toLowerCase() !== 'none') {
    throw new SvgMathError('暂不支持 accumulate 动画');
  }
  const type = attribute(animation, 'type');
  const animated = transformMatrix(type, interpolateValues(animation, progress, [0]));
  return String(attribute(animation, 'additive') || 'replace').toLowerCase() === 'sum'
    ? multiply(base, animated)
    : animated;
}

function closestSvg(node) {
  let current = node;
  while (current) {
    if (elementName(current) === 'svg') return current;
    current = current.parent;
  }
  return null;
}

function cachedSample(cache, node, root, progress) {
  const rootCache = cache?.get(node)?.get(root);
  return rootCache?.has(progress)
    ? { found: true, value: rootCache.get(progress) }
    : { found: false, value: null };
}

function cacheSample(cache, node, root, progress, value) {
  if (!cache) return value;
  let nodeCache = cache.get(node);
  if (!nodeCache) {
    nodeCache = new WeakMap();
    cache.set(node, nodeCache);
  }
  let rootCache = nodeCache.get(root);
  if (!rootCache) {
    rootCache = new Map();
    nodeCache.set(root, rootCache);
  }
  rootCache.set(progress, value);
  return value;
}

function consumeOperation(runtime) {
  if (!runtime) return;
  runtime.operations += 1;
  if (runtime.operations > runtime.maxOperations) {
    runtime.unavailable = `SVG 数学计算超过 ${runtime.maxOperations} 次操作的资源上限`;
    throw new SvgMathError(runtime.unavailable);
  }
}

function worldMatrix(node, root, progress, runtime) {
  const cached = cachedSample(runtime?.matrices, node, root, progress);
  if (cached.found) return cached.value;
  consumeOperation(runtime);
  const chain = [];
  let current = node;
  while (current) {
    chain.unshift(current);
    if (chain.length > 64) throw new SvgMathError('SVG 元素嵌套超过 64 层');
    if (current === root) break;
    current = current.parent;
  }
  if (chain[0] !== root) throw new SvgMathError('元素不属于同一个 SVG 场景');
  return cacheSample(
    runtime?.matrices,
    node,
    root,
    progress,
    chain.reduce((matrix, item) => multiply(matrix, localMatrix(item, progress)), IDENTITY)
  );
}

function explicitGeometry(node, progress) {
  const anchorX = attribute(node, 'data-anchor-x');
  const anchorY = attribute(node, 'data-anchor-y');
  const explicitAnchor = anchorX != null && anchorY != null
    ? { x: svgNumber(anchorX), y: svgNumber(anchorY) }
    : null;
  const explicitBox = attribute(node, 'data-bbox');
  if (explicitBox != null) {
    const [x, y, width, height, ...rest] = numberList(explicitBox);
    if (rest.length || width < 0 || height < 0) throw new SvgMathError('data-bbox 必须为 x y width height');
    return { anchor: explicitAnchor || { x: x + width / 2, y: y + height / 2 }, box: { x, y, width, height } };
  }
  const tag = elementName(node);
  if (tag === 'circle') {
    const x = animatedNumber(node, 'cx', progress);
    const y = animatedNumber(node, 'cy', progress);
    const radius = Math.max(0, animatedNumber(node, 'r', progress));
    return {
      anchor: explicitAnchor || { x, y },
      box: { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 },
      ellipse: { x, y, radiusX: radius, radiusY: radius }
    };
  }
  if (tag === 'ellipse') {
    const x = animatedNumber(node, 'cx', progress);
    const y = animatedNumber(node, 'cy', progress);
    const radiusX = Math.max(0, animatedNumber(node, 'rx', progress));
    const radiusY = Math.max(0, animatedNumber(node, 'ry', progress));
    return {
      anchor: explicitAnchor || { x, y },
      box: { x: x - radiusX, y: y - radiusY, width: radiusX * 2, height: radiusY * 2 },
      ellipse: { x, y, radiusX, radiusY }
    };
  }
  if (['rect', 'image', 'svg'].includes(tag)) {
    const x = animatedNumber(node, 'x', progress);
    const y = animatedNumber(node, 'y', progress);
    let width = Math.max(0, animatedNumber(node, 'width', progress));
    let height = Math.max(0, animatedNumber(node, 'height', progress));
    if (tag === 'svg' && (!width || !height) && attribute(node, 'viewBox')) {
      const viewBox = numberList(attribute(node, 'viewBox'));
      if (viewBox.length === 4) [,, width, height] = viewBox;
    }
    return { anchor: explicitAnchor || { x: x + width / 2, y: y + height / 2 }, box: { x, y, width, height } };
  }
  if (tag === 'line') {
    const x1 = animatedNumber(node, 'x1', progress);
    const y1 = animatedNumber(node, 'y1', progress);
    const x2 = animatedNumber(node, 'x2', progress);
    const y2 = animatedNumber(node, 'y2', progress);
    return {
      anchor: explicitAnchor || { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
      box: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
    };
  }
  if (['polygon', 'polyline'].includes(tag)) {
    const values = numberList(attribute(node, 'points'));
    if (values.length < 4 || values.length % 2) throw new SvgMathError(`${tag} points 必须包含坐标对`);
    const xs = values.filter((_item, index) => index % 2 === 0);
    const ys = values.filter((_item, index) => index % 2 === 1);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    return { anchor: explicitAnchor || { x: x + width / 2, y: y + height / 2 }, box: { x, y, width, height } };
  }
  if (tag === 'text') {
    const x = animatedNumber(node, 'x', progress);
    const y = animatedNumber(node, 'y', progress);
    return { anchor: explicitAnchor || { x, y }, box: { x, y, width: 0, height: 0 } };
  }
  if (explicitAnchor) return { anchor: explicitAnchor, box: null };
  return null;
}

function transformedBox(box, matrix) {
  const corners = [
    applyMatrix(matrix, { x: box.x, y: box.y }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y }),
    applyMatrix(matrix, { x: box.x, y: box.y + box.height }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y + box.height })
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function transformedEllipse(ellipse, matrix) {
  const center = applyMatrix(matrix, { x: ellipse.x, y: ellipse.y });
  const radiusX = Math.hypot(matrix[0] * ellipse.radiusX, matrix[2] * ellipse.radiusY);
  const radiusY = Math.hypot(matrix[1] * ellipse.radiusX, matrix[3] * ellipse.radiusY);
  return {
    x: center.x - radiusX,
    y: center.y - radiusY,
    width: radiusX * 2,
    height: radiusY * 2
  };
}

function mergeBoxes(boxes) {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function worldBox(node, root, progress, depth = 0, runtime) {
  if (depth > 64) throw new SvgMathError('SVG 元素嵌套超过 64 层');
  const cached = cachedSample(runtime?.boxes, node, root, progress);
  if (cached.found) return cached.value;
  consumeOperation(runtime);
  const geometry = explicitGeometry(node, progress);
  if (geometry?.box) {
    const matrix = worldMatrix(node, root, progress, runtime);
    const box = geometry.ellipse
      ? transformedEllipse(geometry.ellipse, matrix)
      : transformedBox(geometry.box, matrix);
    return cacheSample(runtime?.boxes, node, root, progress, box);
  }
  const boxes = [];
  for (const child of childElements(node)) {
    if (SKIPPED_TAGS.has(elementName(child))) continue;
    const box = worldBox(child, root, progress, depth + 1, runtime);
    if (box) boxes.push(box);
  }
  if (boxes.length > 0) {
    return cacheSample(runtime?.boxes, node, root, progress, mergeBoxes(boxes));
  }
  if (geometry?.anchor) {
    const point = applyMatrix(worldMatrix(node, root, progress, runtime), geometry.anchor);
    return cacheSample(runtime?.boxes, node, root, progress, {
      x: point.x, y: point.y, width: 0, height: 0
    });
  }
  throw new SvgMathError(`元素 ${elementName(node) || '未知'} 缺少可计算几何；复杂路径请配置 data-anchor-x/data-anchor-y 或 data-bbox`);
}

function worldAnchor(node, root, progress, runtime) {
  const cached = cachedSample(runtime?.anchors, node, root, progress);
  if (cached.found) return cached.value;
  consumeOperation(runtime);
  const geometry = explicitGeometry(node, progress);
  let point;
  if (geometry?.anchor) {
    point = applyMatrix(worldMatrix(node, root, progress, runtime), geometry.anchor);
  } else {
    const box = worldBox(node, root, progress, 0, runtime);
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return cacheSample(runtime?.anchors, node, root, progress, point);
}

function viewBox(root) {
  const values = numberList(attribute(root, 'viewBox'));
  if (values.length !== 4 || values[2] <= 0 || values[3] <= 0) {
    throw new SvgMathError('SVG viewBox 必须包含有效的 x y width height');
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function formatNumber(value) {
  return Math.round(value * 100) / 100;
}

function createSvgMathEvaluator($, source, options = {}) {
  const samples = Math.max(2, Math.min(24, Number(options.samples) || 12));
  const passRatio = Math.max(0.5, Math.min(1, Number(options.pass_ratio) || 0.9));
  const sourceBytes = Buffer.byteLength(String(source || ''));
  const svgNodes = sourceBytes <= MAX_SOURCE_BYTES ? $('svg *').toArray() : [];
  const times = Array.from({ length: samples }, (_item, index) => index / (samples - 1));
  const selectorCache = new Map();
  const runtime = {
    anchors: new WeakMap(),
    boxes: new WeakMap(),
    matrices: new WeakMap(),
    operations: 0,
    maxOperations: MAX_GEOMETRY_OPERATIONS,
    unavailable: ''
  };
  let unavailable = '';
  if (sourceBytes > MAX_SOURCE_BYTES) {
    unavailable = 'HTML 超过 2 MB 的数学检测上限';
  } else if (svgNodes.length > MAX_SVG_NODES) {
    unavailable = `SVG 元素超过 ${MAX_SVG_NODES} 个的数学检测上限`;
  } else if ($('script').length > 0) {
    unavailable = '检测到脚本；SVG 数学检测只支持声明式动画';
  } else if (svgNodes.some((node) => elementName(node) === 'foreignobject')) {
    unavailable = '检测到 foreignObject；SVG 数学检测只支持 SVG 几何元素';
  } else if (svgNodes.some((node) => ['animatemotion', 'set'].includes(elementName(node)))) {
    unavailable = '检测到 animateMotion 或 set；SVG 数学检测只支持 animate/animateTransform';
  } else if (svgNodes.some((node) =>
    elementName(node) === 'animate' &&
    ['d', 'points', 'transform', 'viewbox'].includes(String(attribute(node, 'attributeName') || '').toLowerCase()))) {
    unavailable = '检测到暂不支持的几何属性动画；请使用可计算的坐标属性或 animateTransform';
  } else {
    const styles = $('style').text();
    const inlineStyles = $('[style]').toArray().map((node) => attribute(node, 'style')).join('\n');
    if (/@keyframes|\banimation(?:-name)?\s*:|\btransform\s*:/i.test(`${styles}\n${inlineStyles}`)) {
      unavailable = '检测到 CSS 动画或 CSS transform；请使用 SVG animate/animateTransform';
    }
  }

  function selectOne(selector, label) {
    let nodes;
    try {
      if (!selectorCache.has(selector)) {
        selectorCache.set(selector, $(selector).toArray().filter((node) => closestSvg(node)));
      }
      nodes = selectorCache.get(selector);
    } catch (error) {
      throw new SvgMathError(`${label}选择器无效：${error.message}`);
    }
    if (nodes.length !== 1) throw new SvgMathError(`${label}选择器必须在 SVG 中精确匹配 1 个元素，实际为 ${nodes.length} 个`);
    return nodes[0];
  }

  function thresholdAt(rule, reference, root, progress) {
    const configured = Number(rule.geometry_threshold);
    if (!Number.isFinite(configured) || configured < 0) throw new SvgMathError('数学判定阈值无效');
    if (!reference) return configured;
    if (closestSvg(reference) !== root) throw new SvgMathError('尺寸参照元素必须与源元素位于同一个 SVG');
    const box = worldBox(reference, root, progress, 0, runtime);
    const scale = Math.max(box.width, box.height) / 2;
    if (!(scale > 0)) throw new SvgMathError('尺寸参照元素没有可用尺寸');
    return configured * scale;
  }

  function evaluate(rule) {
    const base = { passed: false, indeterminate: false, message: '' };
    try {
      if (unavailable || runtime.unavailable) throw new SvgMathError(unavailable || runtime.unavailable);
      const sourceNode = selectOne(rule.source_selector, '源元素');
      const root = closestSvg(sourceNode);
      const operation = rule.geometry_operation;
      const needsTarget = ['distance_lte', 'above', 'below', 'left_of', 'right_of', 'aligned_x', 'aligned_y']
        .includes(operation);
      const targetNode = needsTarget && rule.target_selector
        ? selectOne(rule.target_selector, '目标元素')
        : null;
      const referenceNode = operation !== 'rotation_gte' && rule.reference_selector
        ? selectOne(rule.reference_selector, '尺寸参照元素')
        : null;
      if (needsTarget && !targetNode) throw new SvgMathError('该数学关系缺少目标元素选择器');
      if (targetNode && closestSvg(targetNode) !== root) throw new SvgMathError('源元素和目标元素必须位于同一个 SVG');

      if (operation === 'motion_gte') {
        const points = times.map((time) => worldAnchor(sourceNode, root, time, runtime));
        let maximum = 0;
        for (let left = 0; left < points.length; left += 1) {
          for (let right = left + 1; right < points.length; right += 1) {
            maximum = Math.max(maximum, distance(points[left], points[right]));
          }
        }
        const threshold = thresholdAt(rule, referenceNode, root, 0);
        return { ...base, passed: maximum >= threshold, message: `最大位移 ${formatNumber(maximum)}，要求不少于 ${formatNumber(threshold)}` };
      }

      if (operation === 'rotation_gte') {
        const angles = times.map((time) => {
          const matrix = worldMatrix(sourceNode, root, time, runtime);
          return Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
        });
        const unwrapped = [angles[0]];
        for (let index = 1; index < angles.length; index += 1) {
          let delta = angles[index] - angles[index - 1];
          while (delta > 180) delta -= 360;
          while (delta < -180) delta += 360;
          unwrapped.push(unwrapped[index - 1] + delta);
        }
        const change = Math.max(...unwrapped) - Math.min(...unwrapped);
        const threshold = Number(rule.geometry_threshold);
        return { ...base, passed: change >= threshold, message: `旋转变化 ${formatNumber(change)}°，要求不少于 ${formatNumber(threshold)}°` };
      }

      if (operation === 'loop_distance_lte') {
        const start = worldAnchor(sourceNode, root, 0, runtime);
        const end = worldAnchor(sourceNode, root, 1, runtime);
        const actual = distance(start, end);
        const threshold = thresholdAt(rule, referenceNode, root, 0);
        return { ...base, passed: actual <= threshold, message: `首尾位置距离 ${formatNumber(actual)}，要求不超过 ${formatNumber(threshold)}` };
      }

      let passed = 0;
      let maximumObserved = 0;
      for (const time of times) {
        const sourcePoint = worldAnchor(sourceNode, root, time, runtime);
        const targetPoint = targetNode ? worldAnchor(targetNode, root, time, runtime) : null;
        const threshold = thresholdAt(rule, referenceNode, root, time);
        let currentPassed = false;
        if (operation === 'distance_lte') {
          const actual = distance(sourcePoint, targetPoint);
          maximumObserved = Math.max(maximumObserved, actual);
          currentPassed = actual <= threshold;
        } else if (operation === 'above') {
          currentPassed = sourcePoint.y <= targetPoint.y + threshold;
        } else if (operation === 'below') {
          currentPassed = sourcePoint.y >= targetPoint.y - threshold;
        } else if (operation === 'left_of') {
          currentPassed = sourcePoint.x <= targetPoint.x + threshold;
        } else if (operation === 'right_of') {
          currentPassed = sourcePoint.x >= targetPoint.x - threshold;
        } else if (operation === 'aligned_x') {
          const actual = Math.abs(sourcePoint.x - targetPoint.x);
          maximumObserved = Math.max(maximumObserved, actual);
          currentPassed = actual <= threshold;
        } else if (operation === 'aligned_y') {
          const actual = Math.abs(sourcePoint.y - targetPoint.y);
          maximumObserved = Math.max(maximumObserved, actual);
          currentPassed = actual <= threshold;
        } else if (operation === 'inside_viewbox') {
          const box = worldBox(sourceNode, root, time, 0, runtime);
          const bounds = viewBox(root);
          currentPassed = box.x >= bounds.x - threshold && box.y >= bounds.y - threshold &&
            box.x + box.width <= bounds.x + bounds.width + threshold &&
            box.y + box.height <= bounds.y + bounds.height + threshold;
        } else {
          throw new SvgMathError(`不支持 SVG 数学关系 ${operation || '未知类型'}`);
        }
        if (currentPassed) passed += 1;
      }
      const ratio = passed / times.length;
      const detail = ['distance_lte', 'aligned_x', 'aligned_y'].includes(operation)
        ? `，最大观测值 ${formatNumber(maximumObserved)}`
        : '';
      return {
        ...base,
        passed: ratio >= passRatio,
        message: `${passed}/${times.length} 个采样点符合关系，通过率 ${Math.round(ratio * 100)}%，要求至少 ${Math.round(passRatio * 100)}%${detail}`
      };
    } catch (error) {
      return {
        ...base,
        indeterminate: true,
        message: error instanceof SvgMathError ? error.message : `SVG 数学检测失败：${error.message}`
      };
    }
  }

  return { evaluate };
}

module.exports = {
  MAX_GEOMETRY_OPERATIONS,
  MAX_SOURCE_BYTES,
  MAX_SVG_NODES,
  SvgMathError,
  applyMatrix,
  createSvgMathEvaluator,
  multiply,
  parseTransform
};
