const form = document.querySelector('#login-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#login-submit');
  const error = document.querySelector('#login-error');
  error.textContent = ''; button.disabled = true; button.textContent = 'Входим…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: form.elements.username.value, password: form.elements.password.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось войти');
    location.replace(data.user.role === 'employee' ? '/employee' : '/client');
  } catch (err) { error.textContent = err.message; button.disabled = false; button.textContent = 'Войти в аккаунт →'; }
});
document.querySelector('#toggle-password').addEventListener('click', () => {
  const input = document.querySelector('#password'), button = document.querySelector('#toggle-password');
  input.type = input.type === 'password' ? 'text' : 'password';
  button.textContent = input.type === 'password' ? 'Показать' : 'Скрыть';
  button.setAttribute('aria-label', `${button.textContent} пароль`);
});
document.querySelector('#login-submit').disabled = false;
