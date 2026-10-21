'use strict';

const { minorToDecimal, openText } = require('./security');

const MAX_NEARBY_ORDERS = 100;
const NEARBY_ORDER_WINDOW_SECONDS = 180;

function orderEmail(secret, order) {
  if (!order?.user_email_ciphertext) return null;
  try {
    return openText(secret, 'order-user-email:v1', order.user_email_ciphertext, order.id);
  } catch {
    return null;
  }
}

function buildOrderAlertContext({ db, secret, order, paymentMode, paidAt, amountMinor }) {
  const context = {
    orderNo: order?.order_no || null,
    userId: order?.user_id || null,
    userEmail: orderEmail(secret, order),
    nearbyOrders: null
  };
  if (context.userEmail) return context;

  const paymentTime = Date.parse(paidAt);
  const from = new Date(paymentTime - NEARBY_ORDER_WINDOW_SECONDS * 1000).toISOString();
  const until = new Date(paymentTime + NEARBY_ORDER_WINDOW_SECONDS * 1000).toISOString();
  return db.transaction(() => {
    const counts = db.prepare(`
      SELECT COUNT(*) AS orders, COUNT(DISTINCT user_id) AS users FROM recharge_orders
      WHERE payment_mode = ? AND created_at <= ? AND expires_at >= ?
    `).get(paymentMode, until, from);
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT id, order_no, user_id, user_email_ciphertext, requested_amount_minor,
               payable_amount_minor, status, created_at, expires_at,
               row_number() OVER (
                 PARTITION BY user_id
                 ORDER BY CASE WHEN payable_amount_minor = ? THEN 0 ELSE 1 END,
                          abs(julianday(created_at) - julianday(?)), created_at, id
               ) AS user_order_rank
        FROM recharge_orders
        WHERE payment_mode = ? AND created_at <= ? AND expires_at >= ?
      )
      ORDER BY user_order_rank, CASE WHEN payable_amount_minor = ? THEN 0 ELSE 1 END,
               abs(julianday(created_at) - julianday(?)), created_at, id
      LIMIT ?
    `).all(Math.abs(amountMinor), paidAt, paymentMode, until, from, Math.abs(amountMinor), paidAt, MAX_NEARBY_ORDERS);
    context.nearbyOrders = {
      from,
      until,
      total: counts.orders,
      totalUsers: counts.users,
      orders: rows.map((row) => ({
        orderNo: row.order_no,
        userId: String(row.user_id),
        userEmail: orderEmail(secret, row),
        requestedAmount: minorToDecimal(row.requested_amount_minor || row.payable_amount_minor),
        payableAmount: minorToDecimal(row.payable_amount_minor),
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      }))
    };
    return context;
  })();
}

module.exports = { buildOrderAlertContext, MAX_NEARBY_ORDERS, NEARBY_ORDER_WINDOW_SECONDS };
