# Интеграция с API Poster: что подтверждено

Официальная документация (dev.joinposter.com) из среды разработки была недоступна.
Сверка сделана по исходникам npm-пакетов `joinposter-api@0.0.47` (типы ответов API),
`joinposter@0.2.0` и `poster-api`. Ниже то, что из них следует и как это использует система.

## Подтверждено

| Что | Как в Poster | Где у нас |
|---|---|---|
| Запросы | `GET https://joinposter.com/api/{method}?token=…` → `{ response }` или `{ error: { code, message } }` | `src/poster/client.js` |
| «Не найдено» | `response: false` | возвращаем `null` |
| Ошибка внутри 200 | `response.err_code` | бросаем `PosterError` |
| Чек | `dash.getTransaction` (массив), параметры `include_products`, `include_history`; поля `transaction_id, date_start, date_close, status, guests_count, payed_sum, sum, spot_id, table_id, table_name, name (официант), user_id, transaction_comment` | `normalizeTransaction` |
| Позиции чека | `product_id, modification_id, num, product_price, payed_sum`, в списке — `workshop_id` | `normalizeProductLine` |
| Позиции подробно | `dash.getTransactionProducts`: `product_name, modificator_name, workshop, num, time` | запасной путь |
| История чека | `type_history`: `open, additem, changeitemcount, deleteitem, sendtokitchen, print, comment, settable, setclient, close, delete`; у записи есть `spot_tablet_id` и `time` | касса и режим «после отправки в цех» |
| Касса | в самом чеке её нет, есть в истории (`open` → `spot_tablet_id`) | `tabletId` |
| Товар | `menu.getProduct(s)`: `workshop, photo, photo_origin, cooking_time, product_production_description, modifications[] (modificator_id, modificator_name), group_modifications[].modifications[] (dish_modification_id, name)` | каталог, рецептура, нормы |
| Модификаторы блюд | в заказах передаются как `[{ "m": id, "a": количество }]` | `modifierName` |
| Настройки | `settings.getAllSettings`: `timezones`, `currency` | часовой пояс заведения в отчётах |
| Вебхук | `{ account, account_number, object, object_id, action: added/changed/removed/transformed, time, verify, data }`, подпись `md5(account;object;object_id;action;[data;]time;secret)` | `src/poster/webhook.js` |
| Вебхук приложения | `object: application`, `data: { user_id, access_token }` | новый токен / отключение при удалении |
| OAuth | `https://joinposter.com/api/auth?application_id&redirect_uri&response_type=code` → `POST https://{account}.joinposter.com/api/v2/auth/access_token` (`grant_type, application_id, application_secret, redirect_uri, code`) → `access_token, account_number, ownerInfo.company_name`; ошибка `{ error_type, error_message }` | `/auth/poster/*` |
| Вход изнутри Poster | `POST https://joinposter.com/api/v2/auth/manage` (`application_id, application_secret, code, verify = md5(id:secret:code)`) | `/auth/poster/manage` |

## Проверить на живом аккаунте

- [ ] Принимает ли `dash.getTransactions` (список) параметр `include_history`. Если нет, режим «после отправки в цех» сам дозапрашивает чек по одному: работает, но запросов больше.
- [ ] Единица `cooking_time`. Сейчас значения до 60 считаются минутами, больше 60 — секундами.
- [ ] В каком методе техкарта (`ingredients`) и в каких единицах вес (на порцию? граммы или килограммы?).
- [ ] С какого адреса открываются `photo` / `photo_origin`.
- [ ] Деньги в копейках (`POSTER_MONEY_DIVISOR=100`): сверить сумму чека с Poster.
- [ ] Как в чеке у блюда передаются модификаторы: `modification_id` или JSON `modification`.
