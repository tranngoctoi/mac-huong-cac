# Mặc Hương Các Studio — Studio Dịch & Biên Tập Truyện Chữ Trung–Việt AI

**Mặc Hương Các Studio** là nền tảng bàn làm việc chuyên sâu dành cho dịch giả, biên tập viên và độc giả truyện chữ Trung–Việt (Tiên hiệp, Huyền huyễn, Đô thị, Khoa huyễn, Võng du, Lịch sử, Ngôn tình, Đam mỹ...). Ứng dụng kết hợp quy trình **Song ngữ 1:1 Block-ID (`TITLE`, `P0001`..`Pxxxx`)**, **Xoay vòng 50 API Keys & Dịch/Biên tập đa luồng (`1x–10x`)**, **Chống đứt cáp 300s hai tầng (Streaming Heartbeat + Tự động làm mới Sợi dây 1)**, **Quét QA Đa Tiêu Chí**, **Trình đọc Clean Justified Reader** và **Đóng gói chuẩn W3C EPUB 3.3 + Backup v5 `.ZIP`**.

---

## ✨ Tính Năng Nổi Bật

### 1. Kiến Trúc Dịch & Biên Tập Song Ngữ 1:1 Block-ID (`TITLE`, `P0001`..`Pxxxx`)
- **Bất biến 1:1 Block-ID**: Mỗi chương được chuẩn hóa thành `TITLE` + các đoạn `P0001`, `P0002`... cố định vị trí. Bản dịch JSON Structured Output (`blocks-v1` / `chapter-realign-edit-v1`) đối chiếu chính xác từng đoạn với nguyên tác chữ Hán, tuyệt đối không làm dồn hàng hay lệch đoạn.
- **2 vai trò System Instruction độc lập**:
  - **Preset Dịch Thuật (`role: 'translation'`)**: Tích hợp sẵn **Bản Cô Đọng 1.14.1** (Mặc định) và **Bản Đầy Đủ 15 Mục 1.14.0**.
  - **Preset Biên Tập AI (`role: 'editorial'`)**: Tích hợp sẵn **Biên Tập Trung–Việt — Flash Đa Thể Loại (Bản Cô Đọng 1.14.1)** và **Biên Tập AI — Flash / Flash-Lite (Bản Đầy Đủ 10 Mục 1.14.0)**.
- **4 thao tác chỉnh đoạn trực tiếp tại dòng `Pxxxx`**: `[Gộp ↓]`, `[Tách ↵]` (`Ctrl+Enter`), `[Đẩy ↓]`, `[Kéo ↑]`, cùng nút **`AI Dịch Block`** (`block-cleanup-v1`) cho từng đoạn riêng lẻ.

### 2. Pool 50 API Keys, Đa Luồng `1x–10x` & Chống Đứt Cáp 300s (Sợi Dây 1)
- **Pool 50 khóa Gemini độc lập**: Lưu bền vững trên máy chủ (`/data/project-key-pool.json`), tự động xoay vòng Round-Robin, cô lập khóa chạm hạn mức `429` và tự động thử khóa kế tiếp (`maxRetries: 0` ở tầng SDK để chuyển khóa tức thời).
- **4 mức Thinking Level**: `minimal` (Tối thiểu — siêu tốc trên dòng `flash-lite`, tự động nâng lên `low` trên model không phải lite để tránh lỗi HTTP 400), `low` (Thấp), `medium` (Trung bình), `high` (Cao — mặc định suy luận sâu). Tự động hạ từ `high` xuống `low` ở lượt thử lại với chương dài (`>= 6.000` chữ Hán).
- **Cơ chế chống Gateway Timeout 300s kép**:
  1. **Cách 2 — Streaming Heartbeat (`createWire1HeartbeatStream`)**: Mở luồng HTTP 200 ngay tại `t=0ms` và truyền xung nhịp trắng mỗi `10s` để giữ kết nối ấm qua Reverse Proxy.
  2. **Cách 1 — Tự động làm mới Sợi dây 1 (`renewWire1`)**: Nếu một lượt gọi vượt ngưỡng an toàn (`>= 90s`) mà gặp lỗi, máy chủ đóng kết nối cũ và báo trình duyệt mở tức thì một HTTP Request mới (`X-MHC-Wire-Renewal`), đưa bộ đếm 300s của cổng mạng về `0s`.

### 3. Pre-Scan Glossary, Quét QA Đa Tiêu Chí & Tìm/Thay Toàn Văn
- **AI Pre-Scan Glossary**: Quét `N` chương đầu bằng AI để trích xuất Nhân vật, Địa danh, Cảnh giới, Pháp bảo, Xưng hô kèm tần suất xuất hiện và dẫn chứng ngữ cảnh trước khi dịch hàng loạt.
- **Quét QA Đa Tiêu Chí**: Tự động kiểm tra Sót Hán tự, Lọt từ tiếng Anh, Vi phạm Glossary, Lệch số đoạn 1:1 và câu văn quá dài.
- **Tìm & Thay Thế Toàn Văn**: Hỗ trợ phân biệt chữ hoa/thường (`Aa`), khớp nguyên từ, biểu thức chính quy (`Regex`), xem trước ngữ cảnh và hoàn tác (`Undo`) 1 chạm.

### 4. Trình Đọc Clean Justified Reader & Xuất Bản EPUB 3.3 / Backup `.ZIP` v5
- **Clean Justified Reader**: Căn đều hai bên (`text-align: justify`), 3 màu bút dạ quang (`Vàng Hổ Phách`, `Xanh Ngọc Bích`, `Xanh Thanh Thiên`) kèm ghi chú cá nhân, đánh dấu trang (`Bookmark`), tải phông chữ riêng (`.ttf`, `.otf`, `.woff`, `.woff2`) và kho giao diện nền giấy.
- **Đóng gói chuẩn W3C EPUB 3.3 & Backup `.ZIP` v5**: Tương thích Apple Books, Kindle, Kobo, Google Play Books; hỗ trợ sao lưu và khôi phục trọn vẹn dự án giữa các thiết bị.

---

## 🚀 Chạy Ứng Dụng Trên Máy Cá Nhân (Localhost)

**Yêu cầu:** Node.js 18+ (khuyến nghị Node.js 20 LTS trở lên).

1. **Cài đặt thư viện phụ thuộc:**
   ```bash
   npm install
   ```
2. **Thiết lập biến môi trường (tùy chọn):**
   - Sao chép `.env.example` thành `.env.local` và điền `GEMINI_API_KEY` nếu muốn cấu hình khóa mặc định trên máy chủ, hoặc nạp trực tiếp danh sách tối đa **50 API Keys** ngay trong giao diện **`Preset & Model` -> `Xoay Vòng 50 API Keys`** của ứng dụng.
3. **Khởi động máy chủ phát triển (cổng 3000):**
   ```bash
   npm run dev
   ```
4. Mở trình duyệt tại địa chỉ: [http://localhost:3000](http://localhost:3000)

5. **Chạy bộ kiểm thử đơn vị (Unit Tests):**
   ```bash
   npx tsx --test lib/structured-output.test.ts
   ```

---

## 📚 Tài Liệu Hướng Dẫn Chi Tiết

- 📖 **[Hướng Dẫn Sử Dụng Toàn Diện (`HUONG_DAN_SU_DUNG.md`)](./HUONG_DAN_SU_DUNG.md)**: Sổ tay tra cứu đầy đủ 12 chuyên mục từ A–Z (cũng được tích hợp trực tiếp trong nút **Hướng Dẫn** trên thanh công cụ của Studio).
- 🐙 **[Hướng Dẫn Đẩy Code Lên GitHub (`HUONG_DAN_GITHUB.md`)](./HUONG_DAN_GITHUB.md)**: Quy trình khởi tạo Git, bảo mật API Key và đồng bộ mã nguồn lên GitHub.
