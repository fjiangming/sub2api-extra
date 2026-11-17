'use strict';

function sendPayload(req, res, value) {
  if (req.query.download === '1') return res.type('application/octet-stream').attachment(`conversation-${req.params.id}-${req.params.side}-${req.query.source || 'masked'}.raw`).send(value.body);
  if (['preview','text'].includes(req.query.view)) {
    const truncated = req.query.view === 'preview' && value.text !== null && value.text.length > 65536;
    let text = truncated ? value.text.slice(0,65536) : value.text;
    if (truncated && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0,-1);
    return res.json({text,sha256:value.sha256,bytes:value.bytes,truncated});
  }
  return res.json({text:value.text,base64:value.body.toString('base64'),sha256:value.sha256,bytes:value.bytes});
}

module.exports = {sendPayload};
