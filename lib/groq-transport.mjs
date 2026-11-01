const DEFAULT_GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export function groqTransport(runtime = {}) {
  const raw = runtime.GROQ_API_URL || DEFAULT_GROQ_API_URL;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid Groq API URL');
  const headers = {
    Authorization: `Bearer ${runtime.GROQ_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (runtime.GROQ_RELAY_TOKEN) headers['X-VTB-Relay-Token'] = runtime.GROQ_RELAY_TOKEN;
  return { url: url.href, headers };
}

