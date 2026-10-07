export const PRODUCTS = Object.freeze({
  statistics: Object.freeze({ id: 'statistics', amount: 699900, description: '统计科研全课程学习计划', path: '/' }),
  ai: Object.freeze({ id: 'ai', amount: 289900, description: 'AI 数据分析实战课程', path: '/ai' }),
});
export function productFor(id = 'statistics') {
  return typeof id === 'string' && Object.hasOwn(PRODUCTS, id) ? PRODUCTS[id] : null;
}
export function validTransaction(transaction, order, config) {
  const product = order && productFor(order.product_id);
  return Boolean(product && order.amount === product.amount && transaction.trade_state === 'SUCCESS'
    && transaction.appid === config.appId && transaction.mchid === config.mchId
    && transaction.amount?.currency === 'CNY' && transaction.amount.total === order.amount
    && transaction.payer?.openid === order.openid && transaction.out_trade_no === order.out_trade_no
    && typeof transaction.transaction_id === 'string' && transaction.transaction_id.length > 0
    && (order.status !== 'paid' || order.transaction_id === transaction.transaction_id));
}
