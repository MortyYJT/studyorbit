/** Parse browser-selected API text, allowing Canvas's JSON prefix and viewer footer. */
export function parseCoursePage(text) {
  const source = text.replace(/^\uFEFF/, '').trim();
  const start = source.search(/[\[{]/);
  if (start < 0 || !/^(?:while\s*\(\s*1\s*\)\s*;\s*)?$/.test(source.slice(0, start))) {
    throw new Error('未复制到 JSON。请确认浏览器显示的是课程 API，而不是登录页。');
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth++;
    else if ((char === ']' || char === '}') && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('复制到的 JSON 不完整，稍后重试。');
  let items;
  try { items = JSON.parse(source.slice(start, end)); }
  catch { throw new Error('复制到的内容不是有效 JSON。'); }
  if (!Array.isArray(items)) throw new Error('接口没有返回课程数组，可能未登录或没有访问权限。');
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0
      || (item.name !== undefined && typeof item.name !== 'string')
      || (item.course_code !== undefined && typeof item.course_code !== 'string')) {
      throw new Error('返回的数据不是预期的课程列表，停止解析，未覆盖已有结果。');
    }
  }
  return items;
}

/** Keep all candidates, including communities and entries without subject codes. */
export function normalizeCourses(items) {
  return [...new Map(items.map(item => [String(item.id), {
    id: String(item.id),
    name: item.name || item.course_code || `课程 ${item.id}（名称不可读）`,
    code: item.course_code ?? null,
    term: typeof item.term?.name === 'string' ? item.term.name : null,
    url: `https://canvas.lms.unimelb.edu.au/courses/${item.id}`,
  }])).values()];
}
