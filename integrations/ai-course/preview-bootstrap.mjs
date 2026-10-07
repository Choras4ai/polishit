process.env.APP_PORT = '3101';
process.env.DB_PATH = '/var/lib/statistics-course-pay/ai-preview-20260912.sqlite';
process.env.STATIC_ROOT = '/opt/statistics-course-pay/mainland/releases/ai-20260912-1/site';

await import('./server.mjs');
