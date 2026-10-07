(function (global) {
  'use strict';

  const TASK_PANE_ID = 'runshi-document-assistant';

  function addinBaseUrl() {
    return 'https://www.runshi.top/addins/wps';
  }

  function findPane(application) {
    if (typeof application.GetTaskPane !== 'function') return null;
    try {
      return application.GetTaskPane(TASK_PANE_ID);
    } catch (_) {
      return null;
    }
  }

  function openRunShiTaskPane() {
    const application = global.Application || global.wps;
    if (!application || typeof application.CreateTaskPane !== 'function') {
      throw new Error('当前 WPS 版本不支持任务窗格。');
    }
    let pane = findPane(application);
    if (!pane) pane = application.CreateTaskPane(`${addinBaseUrl()}/taskpane.html`, TASK_PANE_ID);
    const dock = application.Enum?.JSKsoEnum_msoCTPDockPositionRight;
    if (dock !== undefined) pane.DockPosition = dock;
    pane.Width = 420;
    pane.Visible = true;
    return true;
  }

  global.OpenRunShiTaskPane = openRunShiTaskPane;
  global.GetImage = () => `${addinBaseUrl()}/icon-32.png`;
  global.OnAddinLoad = () => true;
})(window);
