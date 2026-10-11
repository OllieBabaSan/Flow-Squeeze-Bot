export function roleMention(roleId) {
  const normalized = String(roleId || '').trim();
  if (!/^\d{17,20}$/.test(normalized)) return { allowed_mentions: { parse: [] } };
  return {
    content: `<@&${normalized}>`,
    allowed_mentions: { roles: [normalized] },
  };
}
