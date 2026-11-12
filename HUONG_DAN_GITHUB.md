# Hướng Dẫn Đưa Dự Án Lên GitHub (Từ A - Z)

Tài liệu này hướng dẫn từng bước để bạn lưu trữ, quản lý phiên bản và chia sẻ mã nguồn **Mặc Hương Các Studio** lên tài khoản GitHub cá nhân một cách an toàn.

---

## Bước 1: Chuẩn bị công cụ
1. **Tài khoản GitHub**: Đăng ký tại [github.com](https://github.com/) nếu bạn chưa có.
2. **Cài đặt Git**: Tải và cài đặt từ [git-scm.com](https://git-scm.com/). Khi cài đặt, bạn có thể giữ nguyên các thiết lập mặc định (bấm *Next* liên tục).

---

## Bước 2: Tạo Kho chứa (Repository) mới trên GitHub
1. Đăng nhập vào GitHub.
2. Ở góc trên bên phải màn hình, bấm vào biểu tượng dấu **`+`** -> chọn **New repository**.
3. Điền thông tin cho kho chứa:
   - **Repository name**: Đặt tên cho dự án (ví dụ: `mac-huong-cac-studio`).
   - **Description**: Studio Dịch, Biên Tập & Đọc Truyện Chữ Trung - Việt AI.
   - **Public / Private**: Chọn **Private** (Riêng tư — chỉ mình bạn thấy) hoặc **Public** (Công khai).
   - **Lưu ý quan trọng**: **KHÔNG** tích vào các ô *Add a README file*, *Add .gitignore*, hay *Choose a license* (vì mã nguồn dự án của chúng ta đã có sẵn các tệp này).
4. Bấm nút **Create repository** màu xanh lá. Giữ nguyên trang web hiện ra để lấy đường dẫn ở Bước 4.

---

## Bước 3: Đưa mã nguồn từ máy tính vào Git
1. Mở thư mục chứa dự án trên máy tính của bạn.
2. Mở **Terminal** (hoặc **PowerShell** / **Git Bash**) ngay tại thư mục gốc của dự án (nơi có tệp `package.json`):
   ```powershell
   cd "đường-dẫn-tới-thư-mục-dự-án-của-bạn"
   ```
3. Chạy lần lượt từng lệnh dưới đây (bấm *Enter* sau mỗi dòng):

   - **Cấu hình tên và email (chỉ cần làm 1 lần đầu tiên trên máy):**
     ```powershell
     git config --global user.name "Tên của bạn"
     git config --global user.email "email-dang-ky-github@gmail.com"
     ```

   - **Khởi tạo Git trong thư mục dự án:**
     ```powershell
     git init
     ```

   - **Đưa toàn bộ tệp vào danh sách chuẩn bị lưu:**
     ```powershell
     git add .
     ```
     *(Tệp `.gitignore` có sẵn trong dự án sẽ tự động loại trừ các thư mục nặng như `node_modules`, `.next` và các tệp nhạy cảm như `.env.local` hay `/data/project-key-pool.json` để bảo vệ tuyệt đối API Key của bạn).*

   - **Đóng gói phiên bản đầu tiên (Commit):**
     ```powershell
     git commit -m "Khởi tạo dự án Mặc Hương Các Studio"
     ```

---

## Bước 4: Đẩy mã nguồn lên GitHub
Quay lại trang web GitHub ở **Bước 2**, sao chép đường dẫn kho chứa của bạn (có dạng `https://github.com/ten-ban/mac-huong-cac-studio.git`), sau đó chạy 3 lệnh sau trong Terminal:

```powershell
git branch -M main
git remote add origin https://github.com/ten-ban/mac-huong-cac-studio.git
git push -u origin main
```

> **Lưu ý khi đăng nhập:** Nếu đây là lần đầu tiên bạn đẩy code từ máy tính này, một cửa sổ nhỏ sẽ bật lên yêu cầu bạn bấm **Sign in with your browser** để xác nhận quyền truy cập với GitHub. Sau khi xác nhận xong, toàn bộ mã nguồn sẽ được tải lên.

---

## Bước 5: Cách cập nhật khi bạn sửa code sau này
Mỗi khi bạn chỉnh sửa giao diện hoặc nâng cấp tính năng trên máy tính và muốn cập nhật lên GitHub, bạn chỉ cần mở Terminal tại thư mục dự án và gõ 3 lệnh:

```powershell
git add .
git commit -m "Mô tả ngắn gọn những gì vừa cập nhật"
git push
```

---

## 🔒 Quy Tắc Bảo Mật Quan Trọng
- **Tuyệt đối không** xóa dòng `.env*` hoặc `/data` trong tệp `.gitignore`.
- Không bao giờ dán trực tiếp mã `GEMINI_API_KEY` cố định vào các tệp mã nguồn `.ts` hoặc `.tsx`. Hãy luôn sử dụng bảng quản lý **50 API Keys** trong giao diện ứng dụng hoặc tệp `.env.local` trên máy cá nhân.
