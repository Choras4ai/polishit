'use strict';

/**
 * Built-in API keys (obfuscated).
 * Keys are XOR-encoded to prevent plain-text exposure in source code.
 * Note: This provides casual protection only. For distribution builds,
 * consider using a backend proxy.
 */

// Together AI
const _e = 'XylnPE+7A59yGX00QbMLtVg0RldJ7mqjG3lbUXLlD8F/d0cTeNoxvxIGJTxvxRKJcQs=';
const _s = [0x2b, 0x4e, 0x17, 0x63, 0x39, 0x8a, 0x5c, 0xf1];

// SiliconFlow
const _e2 = 'TxoPJyzBAKdFBlEkPdsXoF4ZSTw52wWrSgdBJDDGHbFKH0c0PNcXtkgHWCE43wihSABU';
const _s2 = [0x3c, 0x71, 0x22, 0x45, 0x5a, 0xb3, 0x6e, 0xd2];

function _decode(encoded, salt) {
  const buf = Buffer.from(encoded, 'base64');
  let result = '';
  for (let i = 0; i < buf.length; i++) {
    result += String.fromCharCode(buf[i] ^ salt[i % salt.length]);
  }
  return result;
}

function getBuiltinKey() {
  return _decode(_e, _s);
}

function getSiliconFlowKey() {
  return _decode(_e2, _s2);
}

module.exports = { getBuiltinKey, getSiliconFlowKey };
