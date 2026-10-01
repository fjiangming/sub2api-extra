'use strict';

const Ajv = require('ajv');
const { load: loadHtml } = require('cheerio');
const { createSvgMathEvaluator } = require('./svg-math');

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

function imageDimensions(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return null;
  const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase();
  if (normalizedMime === 'image/png' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (normalizedMime === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (normalizedMime === 'image/jpeg' && buffer.length >= 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (normalizedMime === 'image/webp' && buffer.length >= 30 && buffer.subarray(0, 4).toString() === 'RIFF') {
    const type = buffer.subarray(12, 16).toString();
    if (type === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
  }
  if (normalizedMime === 'image/svg+xml') {
    try {
      const $ = loadHtml(buffer.toString('utf8'), { xmlMode: true });
      const svg = $('svg').first();
      if (!svg.length) return null;
      const numeric = (value) => {
        const match = String(value || '').match(/^\s*(\d+(?:\.\d+)?)/);
        return match ? Math.round(Number(match[1])) : null;
      };
      let width = numeric(svg.attr('width'));
      let height = numeric(svg.attr('height'));
      const viewBox = String(svg.attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if ((!width || !height) && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
        width ||= Math.round(Math.abs(viewBox[2]));
        height ||= Math.round(Math.abs(viewBox[3]));
      }
      return width > 0 && height > 0 ? { width, height } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function outputSource(output) {
  if (output.text != null) return String(output.text);
  const mime = String(output.mime || '').toLowerCase();
  if (Buffer.isBuffer(output.buffer) && (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml'))) {
    return output.buffer.toString('utf8');
  }
  return '';
}

function outputBytes(output, source = outputSource(output)) {
  return Buffer.isBuffer(output.buffer) ? output.buffer.length : Buffer.byteLength(source);
}

function validateOutputIntegrity(test, output) {
  const source = outputSource(output);
  const bytes = outputBytes(output, source);
  const failures = [];
  if (bytes === 0) failures.push('响应内容为空');

  if (test.output_type === 'html') {
    if (!/<[a-z][\s\S]*>/i.test(source)) failures.push('响应中没有可解析的 HTML 元素');
    try {
      loadHtml(source);
    } catch {
      failures.push('HTML 无法解析');
    }
  }
  if (test.output_type === 'image') {
    if (!String(output.mime || '').toLowerCase().startsWith('image/')) failures.push('响应 MIME 类型不是图片');
    if (!imageDimensions(output.buffer, output.mime)) failures.push('图片文件无法解码或缺少有效尺寸');
  }
  if (test.output_type === 'file' && !Buffer.isBuffer(output.buffer)) {
    failures.push('文件响应没有可保存的二进制内容');
  }
  return { ok: failures.length === 0, failures, source, bytes };
}

function compareText(actual, expected, caseSensitive) {
  if (caseSensitive) return [actual, expected];
  return [actual.toLocaleLowerCase(), expected.toLocaleLowerCase()];
}

function countRequirement(rule, count) {
  const minimum = rule.min_count ?? 1;
  return count >= minimum && (rule.max_count == null || count <= rule.max_count);
}

function evaluateRule(rule, context) {
  const result = {
    id: rule.id,
    label: rule.label,
    type: rule.type,
    severity: rule.severity,
    weight: rule.weight,
    passed: false,
    indeterminate: false,
    message: ''
  };

  switch (rule.type) {
    case 'min_bytes':
      result.passed = context.bytes >= rule.threshold;
      result.message = `${context.bytes} 字节，要求不少于 ${rule.threshold} 字节`;
      break;
    case 'max_bytes':
      result.passed = context.bytes <= rule.threshold;
      result.message = `${context.bytes} 字节，要求不多于 ${rule.threshold} 字节`;
      break;
    case 'exact_text': {
      const [actual, expected] = compareText(context.source.trim(), rule.value.trim(), rule.case_sensitive);
      result.passed = actual === expected;
      result.message = result.passed ? '输出与预期文本完全一致' : '输出与预期文本不一致';
      break;
    }
    case 'contains': {
      const [actual, expected] = compareText(context.source, rule.value, rule.case_sensitive);
      result.passed = actual.includes(expected);
      result.message = result.passed ? '已包含预期文本' : '未包含预期文本';
      break;
    }
    case 'regex':
    case 'not_regex': {
      const matched = new RegExp(rule.value, rule.case_sensitive ? '' : 'i').test(context.source);
      result.passed = rule.type === 'regex' ? matched : !matched;
      result.message = result.passed ? '内容特征符合要求' : '内容特征不符合要求';
      break;
    }
    case 'html_selector': {
      const count = Math.max(context.html(rule.value).length, context.xmlHtml(rule.value).length);
      result.passed = countRequirement(rule, count);
      const maximum = rule.max_count == null ? '' : `，最多 ${rule.max_count} 个`;
      result.message = `匹配到 ${count} 个元素，要求至少 ${rule.min_count ?? 1} 个${maximum}`;
      break;
    }
    case 'svg_geometry': {
      const evaluated = context.svgMath?.evaluate(rule);
      if (!evaluated) {
        result.indeterminate = true;
        result.message = 'SVG 数学检测未开启';
      } else {
        result.passed = evaluated.passed === true;
        result.indeterminate = evaluated.indeterminate === true;
        result.message = evaluated.message;
      }
      break;
    }
    case 'json_schema': {
      try {
        const value = JSON.parse(context.source);
        const validate = ajv.compile(JSON.parse(rule.value));
        result.passed = Boolean(validate(value));
        result.message = result.passed
          ? 'JSON 结构符合 Schema'
          : `JSON 结构不符合 Schema${validate.errors?.[0]?.instancePath ? `：${validate.errors[0].instancePath}` : ''}`;
      } catch (error) {
        result.message = `JSON 无法解析或校验：${error.message}`;
      }
      break;
    }
    case 'mime_type': {
      const actual = String(context.output.mime || '').split(';')[0].trim().toLowerCase();
      const expected = rule.value.trim().toLowerCase();
      result.passed = expected.endsWith('/*') ? actual.startsWith(expected.slice(0, -1)) : actual === expected;
      result.message = `实际 MIME 类型为 ${actual || '未知'}`;
      break;
    }
    case 'image_dimensions': {
      const dimensions = context.dimensions;
      result.passed = Boolean(dimensions) &&
        (rule.min_width == null || dimensions.width >= rule.min_width) &&
        (rule.min_height == null || dimensions.height >= rule.min_height) &&
        (rule.max_width == null || dimensions.width <= rule.max_width) &&
        (rule.max_height == null || dimensions.height <= rule.max_height);
      result.message = dimensions ? `图片尺寸 ${dimensions.width} x ${dimensions.height}` : '无法读取图片尺寸';
      break;
    }
    default:
      result.message = '不支持的规则类型';
  }
  return result;
}

function evaluateOutput(test, output) {
  const integrity = validateOutputIntegrity(test, output);
  const policy = test.validation || {};
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const mathEnabled = test.output_type === 'html' && policy.svg_math?.enabled === true;
  const activeRules = rules.filter((rule) => rule.type !== 'svg_geometry' || mathEnabled);
  if (!integrity.ok) {
    return {
      quality: 'unknown',
      status: 'unknown',
      score: null,
      reason: `输出完整性不足，无法判定：${integrity.failures.join('；')}`,
      source: 'builtin_integrity',
      validationResult: {
        version: 2,
        score: null,
        score_min: null,
        score_max: null,
        coverage: 0,
        passed: 0,
        total: activeRules.length,
        hard_failures: 0,
        integrity_failures: integrity.failures,
        results: []
      }
    };
  }
  if (activeRules.length === 0) {
    return {
      quality: 'unknown',
      status: 'unknown',
      score: null,
      reason: rules.length > 0
        ? '响应完整，但 SVG 数学检测未开启且没有其他判定规则，无法判断模型能力'
        : '响应完整，但没有配置题目判定规则，无法判断模型能力',
      source: 'configured_validation_v2',
      validationResult: {
        version: 2, score: null, score_min: null, score_max: null, coverage: 0,
        passed: 0, total: 0, hard_failures: 0, integrity_failures: [], results: []
      }
    };
  }

  const context = {
    output,
    source: integrity.source,
    bytes: integrity.bytes,
    html: loadHtml(integrity.source, {}, false),
    xmlHtml: loadHtml(integrity.source, { xmlMode: true }, false),
    dimensions: imageDimensions(output.buffer, output.mime),
    svgMath: null
  };
  if (mathEnabled && activeRules.some((rule) => rule.type === 'svg_geometry')) {
    context.svgMath = createSvgMathEvaluator(context.html, integrity.source, policy.svg_math);
  }
  const results = activeRules.map((rule) => evaluateRule(rule, context));
  const scorableResults = results.filter((rule) => !rule.indeterminate);
  const totalWeight = results.reduce((sum, rule) => sum + rule.weight, 0);
  const computableWeight = scorableResults.reduce((sum, rule) => sum + rule.weight, 0);
  const passedWeight = scorableResults.reduce((sum, rule) => sum + (rule.passed ? rule.weight : 0), 0);
  const indeterminateRules = results.filter((rule) => rule.indeterminate);
  const indeterminateWeight = totalWeight - computableWeight;
  const scoreMin = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : null;
  const scoreMax = totalWeight > 0 ? Math.round(((passedWeight + indeterminateWeight) / totalWeight) * 100) : null;
  const coverage = totalWeight > 0 ? Math.round((computableWeight / totalWeight) * 100) : 0;
  const score = indeterminateRules.length === 0 ? scoreMin : null;
  const hardFailures = results.filter((rule) => !rule.indeterminate && !rule.passed && rule.severity === 'hard');
  const hardIndeterminate = indeterminateRules.filter((rule) => rule.severity === 'hard');
  const failures = results.filter((rule) => !rule.indeterminate && !rule.passed);
  let status;
  if (hardFailures.length > 0) status = 'degraded';
  else if (scoreMax <= policy.degraded_threshold) status = 'degraded';
  else if (hardIndeterminate.length > 0) status = 'unknown';
  else if (scoreMin >= policy.normal_threshold) status = 'normal';
  else status = 'unknown';

  const failedLabels = failures.slice(0, 3).map((rule) => rule.label).join('、');
  const scoreLabel = score == null ? `${scoreMin} 至 ${scoreMax} 分` : `${score} 分`;
  const indeterminateCauses = [...new Set(indeterminateRules.map((rule) => rule.message))].slice(0, 2).join('；');
  const indeterminateDetail = indeterminateRules.length > 0
    ? `${indeterminateRules.length} 条规则无法计算${indeterminateCauses ? `：${indeterminateCauses}` : ''}`
    : '';
  let reason;
  if (hardFailures.length > 0) {
    reason = `规则评分${score == null ? '区间' : ''} ${scoreLabel}，核心规则未通过：${failedLabels || '核心规则'}${indeterminateDetail ? `；${indeterminateDetail}` : ''}`;
  } else if (indeterminateRules.length > 0 && status === 'normal') {
    reason = `规则评分区间 ${scoreLabel}，最低分已达到正常线，可计算覆盖率 ${coverage}%；${indeterminateDetail}`;
  } else if (indeterminateRules.length > 0 && status === 'degraded') {
    reason = `规则评分区间 ${scoreLabel}，最高分仍不高于降智线，可计算覆盖率 ${coverage}%；${indeterminateDetail}`;
  } else if (indeterminateRules.length > 0) {
    reason = `规则评分区间 ${scoreLabel}，可计算覆盖率 ${coverage}%，证据不足；${indeterminateDetail}`;
  } else if (status === 'normal') {
    reason = `规则评分 ${score} 分，题目要求已通过`;
  } else if (status === 'degraded') {
    reason = `规则评分 ${score} 分，未通过：${failedLabels || '核心规则'}`;
  } else {
    reason = `规则评分 ${score} 分，证据不足，未通过：${failedLabels || '辅助规则'}`;
  }
  return {
    quality: status,
    status,
    score,
    reason,
    source: 'configured_validation_v2',
    validationResult: {
      version: 2,
      score,
      score_min: scoreMin,
      score_max: scoreMax,
      coverage,
      computable_weight: computableWeight,
      total_weight: totalWeight,
      passed: results.filter((rule) => rule.passed).length,
      total: results.length,
      hard_failures: hardFailures.length,
      indeterminate: indeterminateRules.length,
      integrity_failures: [],
      results
    }
  };
}

module.exports = {
  evaluateOutput,
  evaluateRule,
  imageDimensions,
  outputBytes,
  outputSource,
  validateOutputIntegrity
};
