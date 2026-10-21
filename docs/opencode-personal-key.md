# Персональный ключ Ladder для OpenCode

Персональный ключ нужен, чтобы вызовы конкретного OpenCode были видны в
админке отдельно от общих ключей.

## Создать ключ

1. Откройте `https://llm-ladder.trainedassist.store/admin`.
2. Выберите существующего пользователя из списка или укажите новый `user_id`
   и email. Для нового пользователя аккаунт и первый ключ создаются вместе.
3. Укажите понятное название, например `mac local` или `opencode-office`.
4. Нажмите «Создать ключ» и сразу скопируйте значение: после закрытия окна
   оно больше не показывается.

Не вставляйте значение ключа в issue, PR, чат или документацию.

## Обновить OpenCode на macOS

Сначала нажмите «Скопировать» в окне нового ключа. Закройте OpenCode, затем
запустите в Terminal:

```sh
node <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');

const token = execFileSync('pbpaste', { encoding: 'utf8' }).trim();
if (!token) throw new Error('В буфере нет нового ключа');

for (const path of [
  '/Users/vova/.config/opencode/opencode.json',
  '/Users/vova/.config/opencode/base.json',
]) {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  config.provider.ladder.options.apiKey = token;
  fs.copyFileSync(path, `${path}.before-personal-key.bak`);
  fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\\n`, { mode: 0o600 });
}
NODE
```

Команда обновляет оба активных конфига и создаёт резервные копии с суффиксом
`.before-personal-key.bak`. После этого полностью перезапустите OpenCode.

## Проверить

Сделайте один обычный запрос из OpenCode. В админке на периоде «15 минут»
должна появиться строка с названием этого ключа, пользователем, приложением и
моделью. При подозрении на утечку сначала нажмите «Приостановить» для ключа:
это сразу заблокирует только его, не затрагивая остальные интеграции.
