const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

const LEVEL_COLOR = {
  debug: COLORS.dim,
  info: COLORS.cyan,
  warn: COLORS.yellow,
  error: COLORS.red,
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatFields(fields) {
  if (!fields || typeof fields !== 'object') return '';
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (v instanceof Error) {
        return `${k}=${JSON.stringify(v.message)}`;
      }
      if (typeof v === 'object') {
        try {
          return `${k}=${JSON.stringify(v)}`;
        } catch {
          return `${k}=[object]`;
        }
      }
      return `${k}=${String(v)}`;
    });
  return parts.length ? ` | ${parts.join(' ')}` : '';
}

function write(level, message, fields) {
  const color = LEVEL_COLOR[level] || COLORS.reset;
  const line =
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ` +
    `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ` +
    `${message}${formatFields(fields)}`;
  if (level === 'error') {
    console.error(line);
    if (fields && fields.err && fields.err.stack) {
      console.error(`${COLORS.dim}${fields.err.stack}${COLORS.reset}`);
    } else if (fields && fields.stack) {
      console.error(`${COLORS.dim}${fields.stack}${COLORS.reset}`);
    }
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const logger = {
  debug(message, fields) {
    write('debug', message, fields);
  },
  info(message, fields) {
    write('info', message, fields);
  },
  warn(message, fields) {
    write('warn', message, fields);
  },
  error(message, fields) {
    write('error', message, fields);
  },
  requestError(req, err, extra = {}) {
    write('error', 'request failed', {
      method: req?.method,
      path: req?.originalUrl || req?.url,
      message: err?.message || String(err),
      err,
      ...extra,
    });
  },
  metric(label, fields) {
    write('info', `${COLORS.magenta}${label}${COLORS.reset}`, fields);
  },
  /** Multi-line human-readable status block (host health, etc.). */
  status(title, lines) {
    const bar = `${COLORS.dim}${'─'.repeat(36)}${COLORS.reset}`;
    const header =
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ` +
      `${COLORS.green}STATUS${COLORS.reset} ` +
      `${COLORS.magenta}${title}${COLORS.reset}`;
    console.log(header);
    console.log(bar);
    for (const line of lines || []) {
      console.log(`  ${line}`);
    }
    console.log(bar);
  },
};

module.exports = { logger, LEVELS, COLORS };
