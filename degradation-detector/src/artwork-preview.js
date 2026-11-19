'use strict';

const { load } = require('cheerio');

function fitViewport() {
  const root = document.documentElement, body = document.body;
  let pending = false;
  root.style.setProperty('overflow', 'hidden', 'important');
  body.style.setProperty('overflow', 'visible', 'important');
  root.style.setProperty('transform-origin', '0 0', 'important');

  function fit() {
    pending = false;
    root.style.setProperty('transform', 'none', 'important');
    let left = 0, top = 0;
    let right = Math.max(innerWidth, root.scrollWidth, body.scrollWidth);
    let bottom = Math.max(innerHeight, root.scrollHeight, body.scrollHeight);
    for (const child of body.children) {
      if (['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) continue;
      const rect = child.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      left = Math.min(left, rect.left); top = Math.min(top, rect.top);
      right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
      observer.observe(child);
    }
    const width = right - left, height = bottom - top;
    const scale = Math.min(1, innerWidth / width, innerHeight / height);
    const x = (innerWidth - width * scale) / 2 - left * scale;
    const y = (innerHeight - height * scale) / 2 - top * scale;
    root.style.setProperty('transform', `translate(${x}px, ${y}px) scale(${scale})`, 'important');
  }
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(fit);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(body);
  new MutationObserver(schedule).observe(body, { childList: true, subtree: true, characterData: true });
  addEventListener('resize', schedule);
  addEventListener('load', schedule);
  document.addEventListener('load', schedule, true);
  document.fonts?.ready.then(schedule);
  schedule();
}

function fittedArtwork(html) {
  const document = load(html);
  document('head').append(`<script data-artwork-fit>addEventListener('DOMContentLoaded', ${fitViewport.toString()}, { once: true });</script>`);
  return document.html();
}

module.exports = { fittedArtwork };
