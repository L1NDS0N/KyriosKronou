const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  try {
    await win.loadFile(path.join(__dirname, 'calendar-ui.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve, 30));
      const base = async (from) => ({
        success: true,
        days: { [from.slice(0, 10)]: [{ at: from, id: 'task-1', name: 'Nightly backup', kind: 'backup', page: 'backup', state: 'scheduled' }] },
        totals: { scheduled: 1, executed: 0, failed: 0, sources: 1 },
        hours: new Array(24).fill(0)
      });
      window.api = { getCalendar: async (from) => base(from) };

      KyriosCalendar.open('month', '2026-05-31T12:00:00');
      await settle();
      const firstRender = {
        days: document.querySelectorAll('.cal-day').length,
        cellsWithItems: document.querySelectorAll('.cal-day.has-items').length,
        chips: document.querySelectorAll('.cal-chip').length,
        period: document.getElementById('cal-period').textContent,
        metrics: document.querySelectorAll('.cal-metric').length,
      };

      document.getElementById('cal-next').click();
      await settle();
      const junePeriod = document.getElementById('cal-period').textContent;

      let slowResolve;
      let fastResolve;
      window.api.getCalendar = (from) => new Promise(resolve => {
        if ((window.__calendarCalls || 0) === 0) slowResolve = resolve;
        else fastResolve = resolve;
        window.__calendarCalls = (window.__calendarCalls || 0) + 1;
      });
      document.getElementById('cal-next').click();
      document.querySelector('[data-view="agenda"]').click();
      await settle();
      const agendaResult = await base(new Date().toISOString());
      agendaResult.days = {};
      fastResolve(agendaResult);
      await settle();
      const duringAgenda = document.querySelector('[data-view="agenda"]').classList.contains('active');
      const slowResult = await base(new Date().toISOString());
      slowResult.days = { '2000-01-01': [{ at: '2000-01-01T03:00:00', id: 'stale', name: 'Stale response', kind: 'task', page: 'tasks', state: 'scheduled' }] };
      slowResolve(slowResult);
      await settle();

      return {
        firstRender,
        junePeriod,
        duringAgenda,
        finalView: document.querySelector('.cal-view-btn.active').dataset.view,
        staleVisible: document.getElementById('cal-body').textContent.includes('Stale response'),
      };
    })()`);
    process.stdout.write(`CALENDAR_UI_RESULT=${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
