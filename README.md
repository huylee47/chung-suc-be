# chungsucliqi-be

Fastify API cho đăng nhập, ví Xu, nạp tiền SePay, đơn UID và trang quản trị.

## Chạy local

```powershell
pnpm i
copy .env.example .env
pnpm dev
```

Demo accounts sau khi khởi động API:

- User: `demo@example.com` / `demo123456`
- Admin: lấy theo `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env`

## Checklist cấu hình Turso trước khi go-live

Hiện tại route đang dùng store in-memory để demo nhanh. `src/db.ts` đã có client libSQL, còn `src/schema.sql` là schema Turso cần apply trước khi chuyển route sang persistence thật.

1. Cài Turso CLI và đăng nhập tài khoản Turso.
2. Tạo database:

```powershell
turso db create chungsucliqi
turso db show chungsucliqi --url
turso db tokens create chungsucliqi
```

3. Apply schema:

```powershell
turso db shell chungsucliqi < src/schema.sql
```

4. Điền vào `.env`:

```env
DATABASE_URL=libsql://<database>-<organization>.turso.io
DATABASE_AUTH_TOKEN=<token-tu-turso>
```

5. Trước khi bật production cần chuyển `src/store.ts` sang repository dùng Turso/Drizzle. Không xoá store demo cho đến khi đã test migration, login, số dư, tạo đơn và webhook.

Các bảng chính trong schema:

- `users`: tài khoản, role, số dư và trạng thái.
- `products`: danh sách sản phẩm CRUD.
- `orders`: đơn UID và trạng thái xử lý.
- `topup_transactions`: lệnh nạp, mã nội dung chuyển khoản và mã giao dịch SePay.
- `wallet_ledger`: sổ cái cộng/trừ Xu, dùng để chống cộng tiền trùng.
- `order_status_history`, `admin_audit_logs`: lịch sử thao tác.

## Checklist cấu hình ngân hàng / SePay

Thông tin ngân hàng thật sẽ cắm sau. Không commit API key, webhook secret hoặc số tài khoản vào git.

Điền các biến sau trên máy local/VPS:

```env
SEPAY_API_KEY=<api-key-neu-can-goi-api-sepay>
SEPAY_WEBHOOK_SECRET=<secret-doi-chieu-webhook>
SEPAY_ACCOUNT_NUMBER=<so-tai-khoan-nhan-tien>
SEPAY_BANK_CODE=<ma-ngan-hang>
```

Flow dự kiến:

1. User tạo lệnh tại `POST /api/topups`.
2. Backend sinh `transferContent` duy nhất theo mẫu `NAPXXXXXXUX`, ví dụ `NAP482913U7` (`X` là chữ số).
3. User chuyển khoản đúng số tiền và nội dung.
4. SePay gọi `POST /api/webhooks/sepay`.
5. Backend tìm topup `PENDING`, kiểm tra nội dung + số tiền, lưu `providerReference`, chuyển sang `PAID` và ghi một dòng `wallet_ledger`.
6. Nếu webhook gửi lại, không được cộng số dư lần hai.

Endpoint webhook hiện tại:

```text
POST /api/webhooks/sepay
Header: x-sepay-secret: <SEPAY_WEBHOOK_SECRET>
Body tối thiểu: { "amount": 100000, "content": "CSLQ ...", "referenceCode": "..." }
```

Khi cắm SePay thật cần kiểm tra lại field payload theo tài khoản SePay đang dùng và cấu hình URL public HTTPS, ví dụ:

```text
https://api.<domain>/api/webhooks/sepay
```

## Deploy VPS dự kiến

VPS Ubuntu 22.04/24.04, Node.js LTS, Nginx và PM2 là đủ cho bản đầu.

```bash
sudo apt update
sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable
corepack prepare pnpm@latest --activate
pnpm add -g pm2

git clone <repo-be> /var/www/chungsucliqi-be
cd /var/www/chungsucliqi-be
pnpm i --frozen-lockfile
cp .env.example .env
# chỉnh DATABASE_URL, DATABASE_AUTH_TOKEN, JWT_*, SEPAY_*, CORS_ORIGIN
pnpm build
pm2 start dist/server.js --name chungsucliqi-be
pm2 save
pm2 startup
```

Nginx reverse proxy API về `127.0.0.1:4000`, bật HTTPS bằng Certbot, sau đó đặt:

```env
APP_URL=https://<domain-fe>
CORS_ORIGIN=https://<domain-fe>
PORT=4000
HOST=127.0.0.1
```

Trước khi bàn giao production:

- Đổi `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_PASSWORD` thành secret mạnh.
- Không dùng `DATABASE_URL=file:local.db` trên VPS.
- Backup Turso và kiểm tra log PM2.
- Test `/health`, login admin, CRUD sản phẩm, tạo topup, webhook và cập nhật trạng thái đơn.
