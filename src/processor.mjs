/**
 * src/processor.mjs
 * Kiro-owned processor for SignalDesk-Relay (started 2026-11-15).
 * No runtime dependencies. All message text is untrusted evidence.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const SHANGHAI_OFFSET = '+08:00';

const VALID_CATEGORIES = new Set([
  'mandatory_event',
  'mandatory_task',
  'change_or_cancel',
  'optional_recruitment',
  'useful_info',
  'noise',
]);

const VALID_IMPORTANCE = new Set(['high', 'medium', 'low']);

// ─── parseShanghaiDate ────────────────────────────────────────────────────────

/**
 * Parse a date/time string and return an ISO 8601 string with explicit offset,
 * or null if the input is null / empty / unrecognised.
 *
 * Accepted forms:
 *   1. ISO instant with explicit offset: 2026-11-18T09:00:00+08:00  → returned as-is (validated)
 *   2. YYYY-MM-DD HH:mm  (no timezone)  → interpreted as Asia/Shanghai (+08:00)
 *   3. YYYY-MM-DD        (date only)    → interpreted as 00:00 Asia/Shanghai
 *   4. YYYY年M月D日 HH:mm              → same as form 2
 *   5. YYYY年M月D日                    → same as form 3
 *
 * Month/day without a year is NOT accepted; returns null.
 */
export function parseShanghaiDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;

  // Form 1: explicit ISO offset (YYYY-MM-DDThh:mm[:ss[.fff]]Z|±hh:mm)
  const isoRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  const isoMatch = isoRe.exec(v);
  if (isoMatch) {
    if (!_buildShanghaiISO(isoMatch) || !Number.isFinite(Date.parse(v))) return null;
    const offset = isoMatch[7];
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) return null;
    return v;
  }

  // Form 2/3: YYYY-MM-DD[ HH:mm]
  const ydmRe = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const ydmMatch = ydmRe.exec(v);
  if (ydmMatch) {
    return _buildShanghaiISO(ydmMatch);
  }

  // Form 4/5: YYYY年M月D日[ HH:mm]
  const cnRe = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:[T ]?(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const cnMatch = cnRe.exec(v);
  if (cnMatch) {
    return _buildShanghaiISO(cnMatch);
  }

  return null;
}

/** Build a Shanghai-offset ISO string from a regex match [_, Y, M, D, h, m, s]. */
function _buildShanghaiISO(match) {
  const year  = match[1].padStart(4, '0');
  const month = match[2].padStart(2, '0');
  const day   = match[3].padStart(2, '0');
  const hour  = match[4] != null ? match[4].padStart(2, '0') : '00';
  const min   = match[5] != null ? match[5].padStart(2, '0') : '00';
  const sec   = match[6] != null ? match[6].padStart(2, '0') : '00';
  if (Number(hour) > 23 || Number(min) > 59 || Number(sec) > 59) return null;

  const candidate = `${year}-${month}-${day}T${hour}:${min}:${sec}${SHANGHAI_OFFSET}`;
  if (!Number.isFinite(Date.parse(candidate))) return null;

  // Validate calendar date
  const y = Number(year), m = Number(month), d = Number(day);
  if (m < 1 || m > 12 || d < 1) return null;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > daysInMonth[m - 1]) return null;

  return candidate;
}

// ─── Relative date helpers ────────────────────────────────────────────────────

/**
 * Given an ISO sentAt string and a relative keyword ('今天'|'明天'|'后天'),
 * return a Shanghai-offset ISO date string at 00:00 of that day.
 */
function _relativeDayISO(sentAt, keyword) {
  const base = Date.parse(sentAt);
  if (!Number.isFinite(base)) return null;

  // Convert base to Shanghai calendar date (UTC+8)
  const baseMs = base + 8 * 3600 * 1000;
  const baseDate = new Date(baseMs);
  const y = baseDate.getUTCFullYear();
  const mo = baseDate.getUTCMonth();
  const d = baseDate.getUTCDate();

  let offset = 0;
  if (keyword === '明天') offset = 1;
  else if (keyword === '后天') offset = 2;
  // '今天' → 0

  const target = new Date(Date.UTC(y, mo, d + offset));
  const ty = target.getUTCFullYear().toString().padStart(4, '0');
  const tm = (target.getUTCMonth() + 1).toString().padStart(2, '0');
  const td = target.getUTCDate().toString().padStart(2, '0');
  return `${ty}-${tm}-${td}T00:00:00${SHANGHAI_OFFSET}`;
}

// ─── Text extraction helpers ──────────────────────────────────────────────────

/**
 * Extract date/time strings from message text.
 * Returns an array of { raw, iso } objects; iso may be null if ambiguous.
 * Never infers a year for a bare month/day expression.
 */
function _extractDates(text, sentAt) {
  const found = [];

  // 1. Explicit YYYY年M月D日[ HH:mm]
  const cnDateRe = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:[^\d](\d{1,2}):(\d{2}))?/g;
  let m;
  while ((m = cnDateRe.exec(text)) !== null) {
    const raw = m[0];
    const iso = parseShanghaiDate(
      `${m[1]}年${m[2]}月${m[3]}日` + (m[4] != null ? ` ${m[4].padStart(2,'0')}:${m[5]}` : '')
    );
    found.push({ raw, iso: m[4] == null ? null : iso });
  }

  // 2. Explicit YYYY-MM-DD[ HH:mm]
  const isoDateRe = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?/g;
  while ((m = isoDateRe.exec(text)) !== null) {
    const raw = m[0];
    // If explicit offset present, it's form 1; otherwise treat as Shanghai
    const iso = m[7]
      ? parseShanghaiDate(raw)
      : parseShanghaiDate(
          `${m[1]}-${m[2]}-${m[3]}` + (m[4] != null ? ` ${m[4]}:${m[5]}` : '')
        );
    found.push({ raw, iso: m[4] == null ? null : iso });
  }

  // 3. Relative: 今天/明天/后天 (optional trailing HH:mm)
  const relRe = /(今天|明天|后天)(?:[^\d](\d{1,2}):(\d{2}))?/g;
  while ((m = relRe.exec(text)) !== null) {
    const raw = m[0];
    let dayIso = _relativeDayISO(sentAt, m[1]);
    if (dayIso && m[2] != null) {
      // Replace 00:00 with the given time
      dayIso = dayIso.replace('T00:00:00', `T${m[2].padStart(2,'0')}:${m[3]}:00`);
    }
    found.push({ raw, iso: m[2] == null ? null : parseShanghaiDate(dayIso) });
  }

  // Deduplicate by raw string
  const seen = new Set();
  return found.filter(e => {
    if (seen.has(e.raw)) return false;
    seen.add(e.raw);
    return true;
  });
}

// ─── Classification helpers ───────────────────────────────────────────────────

/** Returns true if the text contains strong voluntary/opt-in signals. */
function _isVoluntary(text) {
  return /自愿|有意愿|感兴趣|自行决定|不作强制|非强制|欢迎参加|可选|有兴趣/.test(text);
}

/** Returns true if the text contains strong mandatory signals. */
function _isMandatory(text) {
  const affirmative = text.replace(/(?:不作|不做|不|非|无需|无须|不必)(?:强制|必须|要求)/g, '自愿');
  return /全体|必须|请[^。！\n]*参加|务必|要求[^。！\n]*参加|强制|需要[^。！\n]*出席|请[^。！\n]*出席|请[^。！\n]*到场|所有[^。！\n]*成员/.test(affirmative);
}

/** Returns true if the text has cancellation / change signals. */
function _isChangeOrCancel(text) {
  return /取消|改期|改为|调整|变更|地点改|时间改|通知更正|重新安排/.test(text);
}

/** Returns true if text has recruitment / 招募 signals. */
function _isRecruitment(text) {
  return /招募|报名|志愿者|志愿|志工|义工/.test(text);
}

/** Returns true if the text has task / submission signals. */
function _isTask(text) {
  return /提交|上传|作业|报告|截止|完成.*并.*提交|下一步/.test(text);
}

/** Returns true if the text has event / gathering signals. */
function _isEvent(text) {
  return /参加|出席|到场|集合|测验|考试|会议|活动|讲座|研讨|培训|晚会/.test(text);
}

/**
 * Lightweight location extraction: 在/到/至 + noun phrase, or recognise
 * room/building patterns. Returns '' if nothing found.
 */
function _extractLocation(text) {
  // Named room: X楼 YN号/N号室/N区, or standalone room-like tokens
  const roomRe = /[\u4e00-\u9fa5\w]+楼\s*[A-Z]?\d+|[A-Z]\d{3,}/;
  const roomM = roomRe.exec(text);
  if (roomM) return roomM[0].trim();

  // 到/在/至 + up to 10 Chinese chars
  const locRe = /(?:到|在|至)([\u4e00-\u9fa5\w·\-·]+(?:室|厅|楼|场|馆|园|区|楼层|号)?)/;
  const locM = locRe.exec(text);
  if (locM) return locM[1].trim();

  return '';
}

/**
 * Extract an action summary from first imperative sentence or first sentence.
 * Keeps it short (≤ 50 chars).
 */
function _extractAction(text) {
  // First imperative: starts with 请/务必/需要/所有
  const impRe = /[请务必需要所有][^。！\n]{2,48}[。！\n]?/;
  const impM = impRe.exec(text);
  if (impM) return impM[0].replace(/[。！\n]+$/, '').trim().slice(0, 50);

  // First sentence
  const firstSent = text.replace(/【[^】]*】/g, '').trim().split(/[。！\n]/)[0];
  return firstSent.slice(0, 50).trim();
}

/**
 * Extract a title: first noun phrase / bracket label or truncated first line.
 */
function _extractTitle(text) {
  // 【label】→ use label if meaningful
  const bracketM = /【([^】]{1,30})】/.exec(text);
  if (bracketM && !/虚构|演示|安全|样例/.test(bracketM[1])) {
    return bracketM[1].trim();
  }

  // First sentence stripped of bracket prefixes
  const stripped = text.replace(/【[^】]*】/g, '').trim();
  const first = stripped.split(/[。！\n]/)[0].trim();
  return first.slice(0, 40) || stripped.slice(0, 40);
}

// ─── analyzeMessage ───────────────────────────────────────────────────────────

/**
 * Analyse a validated message object and return a structured proposal.
 *
 * @param {object} message - { id, platform, account, conversation, sender, sentAt, text }
 * @param {{ now?: string }} [options]
 * @returns {{ category, title, action, summary, importance,
 *             officialStart, officialEnd, deadline, location,
 *             reasons, needsReview }}
 */
export function analyzeMessage(message, { now } = {}) {
  // Treat message text as opaque untrusted data; never execute it.
  const { text = '', sentAt = '' } = message;

  const reasons = [];

  // ── Date extraction ───────────────────────────────────────────────────────
  const dates = _extractDates(text, sentAt);
  const validDates = dates.filter(d => d.iso != null);
  const ambiguousDates = dates.filter(d => d.iso == null);

  if (ambiguousDates.length > 0) {
    reasons.push(`日期或时间不完整或无效（${ambiguousDates.map(d => d.raw).join('、')}），无法确定完整时刻，时间字段置为 null`);
  }

  // Sort valid dates chronologically
  validDates.sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));

  // ── Classify ──────────────────────────────────────────────────────────────
  const voluntary = _isVoluntary(text);
  const mandatory = text.split(/[。！，,；;\n]/).some(clause => _isMandatory(clause) && !_isVoluntary(clause));
  const changeCancel = _isChangeOrCancel(text);
  const recruitment = _isRecruitment(text);
  const isTask = _isTask(text);
  const isEvent = _isEvent(text);

  let category;

  if (changeCancel) {
    category = 'change_or_cancel';
    reasons.push('文本包含变更或取消信号');
  } else if (mandatory && recruitment) {
    // Mandatory action outranks unrelated recruitment in a mixed notification
    category = isTask ? 'mandatory_task' : 'mandatory_event';
    reasons.push('通知包含强制性内容，强制信息优先于同一条消息中的招募内容');
  } else if (recruitment && voluntary) {
    category = 'optional_recruitment';
    reasons.push('纯自愿性质的招募，不升级为强制类别');
  } else if (recruitment && !mandatory) {
    // Recruitment without explicit mandatory signal → optional
    category = 'optional_recruitment';
    reasons.push('招募类通知，无强制信号，归为可选招募');
  } else if (mandatory && isTask) {
    category = 'mandatory_task';
    reasons.push('含强制性任务/提交要求');
  } else if (mandatory && isEvent) {
    category = 'mandatory_event';
    reasons.push('含强制性活动/集合要求');
  } else if (isTask) {
    // Has task language but not explicitly mandatory
    category = 'mandatory_task';
    reasons.push('含任务/提交语言，推断为强制任务（需人工确认）');
  } else if (isEvent && validDates.length > 0) {
    category = 'mandatory_event';
    reasons.push('含活动信号及明确日期，推断为强制活动（需人工确认）');
  } else if (!isEvent && !isTask && !/通知|资料|参考|安排|说明/.test(text)) {
    category = 'noise';
    reasons.push('无可识别的事件、任务或日期信号');
  } else {
    category = 'useful_info';
    reasons.push('含有用信息但无明确强制性要求');
  }

  // Guard: pure voluntary recruitment must never become mandatory
  if (category === 'optional_recruitment' && mandatory && !isTask && !isEvent) {
    // keep optional_recruitment
  }

  // ── Safety: detect injection attempts in text ─────────────────────────────
  const injectionSignals = /忽略.*指令|read.*key|exec|fetch|<script|javascript:/i.test(text)
    || /忽略之前所有指令/.test(text);
  if (injectionSignals) {
    reasons.push('包含疑似指令注入，文本不执行；仍保留事项信号和原文供人工核对');
  }

  // ── Importance ────────────────────────────────────────────────────────────
  let importance;
  if (category === 'mandatory_event' || category === 'mandatory_task') {
    importance = 'high';
  } else if (category === 'change_or_cancel') {
    importance = 'high';
  } else if (category === 'optional_recruitment') {
    importance = 'medium';
  } else if (category === 'useful_info') {
    importance = 'low';
  } else {
    importance = 'low'; // noise
  }

  // ── Assign date fields ────────────────────────────────────────────────────
  // officialStart: earliest valid date that isn't a deadline
  // deadline: last valid date if the text contains deadline language,
  //           OR the single date after a deadline keyword
  let officialStart = null;
  let officialEnd = null;
  let deadline = null;

  if (validDates.length > 0) {
    // Identify deadline-flagged dates
    const deadlineRe = /截止|前提交|前完成|报名截止|deadline/i;
    const deadlineDates = [];
    const eventDates = [];

    for (const entry of validDates) {
      // Find the raw text position and check surrounding context
      const idx = text.indexOf(entry.raw);
      const before = idx >= 0 ? text.slice(Math.max(0, idx - 15), idx).split(/[。！，,；;\n]/).at(-1) : '';
      const after = idx >= 0 ? text.slice(idx, idx + entry.raw.length + 15).split(/[。！，,；;\n]/)[0] : '';
      const context = before + after;
      if (deadlineRe.test(context)) {
        deadlineDates.push(entry);
      } else {
        eventDates.push(entry);
      }
    }

    if (deadlineDates.length > 0) {
      deadline = deadlineDates[deadlineDates.length - 1].iso;
    }

    if (eventDates.length >= 1) {
      officialStart = eventDates[0].iso;
    }
    if (eventDates.length >= 2) {
      officialEnd = eventDates[eventDates.length - 1].iso;
    }

    // Edge case: only deadlines found
    if (!officialStart && deadlineDates.length > 0 && category !== 'noise') {
      reasons.push('只提取到截止日期，未提取到开始时间');
    }
  }

  // If injection → clear date fields
  if (injectionSignals && category === 'noise') {
    officialStart = null;
    officialEnd = null;
    deadline = null;
  }

  // ── Title, action, summary, location ─────────────────────────────────────
  const title    = _extractTitle(text);
  const action   = _extractAction(text);
  const summary  = text.replace(/【[^】]*】/g, '').trim().slice(0, 120);
  const location = _extractLocation(text);

  // ── Ambiguous-date reason ─────────────────────────────────────────────────
  if (validDates.length === 0 && ambiguousDates.length === 0
      && category !== 'noise' && category !== 'useful_info') {
    reasons.push('未发现明确日期，时间字段置为 null');
  }

  return {
    category,
    title,
    action,
    summary,
    importance,
    officialStart,
    officialEnd,
    deadline,
    location,
    reasons,
    needsReview: true,
  };
}
