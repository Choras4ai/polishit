'use strict';

const APP_BUNDLE_IDENTIFIER = 'com.runshi.app';

function isOwnBundleIdentifier(bundleIdentifier) {
  const value = String(bundleIdentifier || '').trim();
  return value === APP_BUNDLE_IDENTIFIER
    || value.startsWith(`${APP_BUNDLE_IDENTIFIER}.`);
}

module.exports = {
  APP_BUNDLE_IDENTIFIER,
  isOwnBundleIdentifier,
};
