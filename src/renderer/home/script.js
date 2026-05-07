'use strict';

(async () => {
  const config = await window.polishAPI.getConfig();
  const presets = await window.polishAPI.getPresets();
  const status = await window.polishAPI.getToolbarStatus();

  // Shortcut display
  const shortcut = config.shortcut || 'CommandOrControl+Alt+V';
  const isMac = window.polishAPI.platform === 'darwin';
  let display;
  if (isMac) {
    display = shortcut
      .replace('CommandOrControl', '⌘')
      .replace('Shift', '⇧')
      .replace('Alt', '⌥')
      .replace(/\+/g, '');
  } else {
    display = shortcut
      .replace('CommandOrControl', 'Ctrl')
      .replace(/\+/g, ' + ');
  }
  document.getElementById('shortcutDisplay').textContent = display;

  // Preset display
  const presetId = config.provider?.preset || 'together';
  const preset = presets.list?.find(p => p.id === presetId);
  document.getElementById('presetDisplay').textContent = preset?.name || presetId;

  // Toolbar display
  const toolbarEnabled = config.ui?.floatingToolbarEnabled !== false;
  document.getElementById('toolbarDisplay').textContent = toolbarEnabled ? '已开启' : '已关闭';

  // Version
  document.getElementById('versionText').textContent = `Version ${config.appVersion || ''}`;

  // Buttons
  document.getElementById('btnSettings').addEventListener('click', () => {
    window.polishAPI.openSettings();
  });

  document.getElementById('btnHelp').addEventListener('click', () => {
    window.polishAPI.openExternal('https://www.runshi.top/');
  });
})();
