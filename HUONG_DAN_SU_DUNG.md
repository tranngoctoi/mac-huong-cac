# CẨM NANG HƯỚNG DẪN SỬ DỤNG TOÀN DIỆN — MẶC HƯƠNG CÁC STUDIO

Chào mừng bạn đến với **Mặc Hương Các Studio** — Hệ thống biên dịch, biên tập song ngữ theo từng đoạn (**1:1 Block-ID**), kiểm định chất lượng (QA), đọc truyện và đóng gói xuất bản **W3C EPUB 3.3** chuyên sâu dành cho tiểu thuyết chữ Hán – Việt.

Tài liệu này hướng dẫn chi tiết từng bước từ lúc khởi tạo bộ truyện, thiết lập 50 khóa Gemini API chạy 10 luồng song song, chống đứt cáp 300s (Sợi dây 1 Heartbeat & Renewal), nạp chương nguyên tác, xây dựng Từ điển tên riêng (Glossary), dịch tự động, biên tập theo mã đoạn `P0001..Pxxxx`, cho đến đọc truyện và xuất sách điện tử.

---

## MỤC LỤC NHANH
1. [Tổng quan giao diện bàn làm việc](#1-tổng-quan-giao-diện-bàn-làm-việc)
2. [Quản lý Thư viện Đa Bộ Truyện & Bảng Tiến Độ](#2-quản-lý-thư-viện-đa-bộ-truyện--bảng-tiến-độ)
3. [Cấu hình AI: Preset Dịch, Preset Biên Tập, Model & Pool 50 API Keys](#3-cấu-hình-ai-preset-dịch-preset-biên-tập-model--pool-50-api-keys)
4. [Nhập chương nguyên tác (Raw) & Nhập bản dịch có sẵn](#4-nhập-chương-nguyên-tác-raw--nhập-bản-dịch-có-sẵn)
5. [Xây dựng Từ điển Tên riêng (Glossary) & Quét AI tự động (Pre-Scan)](#5-xây-dựng-từ-điển-tên-riêng-glossary--quét-ai-tự-động-pre-scan)
6. [Dịch hàng loạt đa luồng (1x–10x) & Hàng đợi Biên tập AI](#6-dịch-hàng-loạt-đa-luồng-1x10x--hàng-đợi-biên-tập-ai)
7. [Bàn Biên Tập Song Ngữ 1:1 Block-ID (`TITLE`, `P0001`..`Pxxxx`)](#7-bàn-biên-tập-song-ngữ-11-block-id-title-p0001pxxxx)
8. [Kiểm định chất lượng tự động (QA Scanner) & Tìm/Thay thế Toàn văn](#8-kiểm-định-chất-lượng-tự-động-qa-scanner--tìmthay-thế-toàn-văn)
9. [Chế độ Đọc Truyện (Clean Justified Reader), Highlight & Bookmark](#9-chế-độ-đọc-truyện-clean-justified-reader-highlight--bookmark)
10. [Xuất sách điện tử W3C EPUB 3.3, Tệp Gộp `.TXT` & Sao lưu `.ZIP` v5](#10-xuất-sách-điện-tử-w3c-epub-33-tệp-gộp-txt--sao-lưu-zip-v5)
11. [Trạm Giám Sát Hệ Thống (System Terminal Drawer)](#11-trạm-giám-sát-hệ-thống-system-terminal-drawer)
12. [Phím tắt bàn phím & Mẹo xử lý sự cố thường gặp](#12-phím-tắt-bàn-phím--mẹo-xử-lý-sự-cố-thường-gặp)

---

## 1. Tổng quan giao diện bàn làm việc

Giao diện **Mặc Hương Các Studio** được thiết kế theo phong cách giấy cổ điển ấm áp (*Warm Archival Paper*), giảm mỏi mắt khi làm việc nhiều giờ liên tục, chia làm **4 khu vực chính**:

1. **Thanh điều hướng trên cùng (Top Header Bar)**:
   - **Thư Viện (`N` bộ)**: Mở kho quản lý tất cả các bộ truyện, xem biểu đồ tròn tiến độ dịch và chuyển đổi nhanh giữa các dự án.
   - **Preset & Model** *(hiển thị tên Model hiện hành + số lượng Keys trong Pool + mức Thinking Level)*: Mở cửa sổ thiết lập Chỉ dẫn dịch thuật, Chỉ dẫn biên tập AI, chọn Model AI, mức độ suy luận (*Thinking Level*) và nạp danh sách tối đa **50 API Keys**.
   - **Glossary (`N`)**: Mở bảng Từ điển tên riêng của bộ truyện đang chọn.
   - **Nhập Raw**: Mở công cụ nạp chương nguyên tác chữ Hán (từ tệp `.TXT`, gói `.ZIP`, dán văn bản trực tiếp hoặc tải từ URL).
   - **EPUB & Backup**: Mở trung tâm đóng gói sách điện tử **EPUB 3.3**, xuất tệp `.TXT` và sao lưu toàn bộ dự án ra gói `.ZIP` v5.
   - **Hướng Dẫn**: Mở nhanh cẩm nang hướng dẫn sử dụng ngay trong ứng dụng.
   - **Terminal**: Bật/tắt ngăn kéo giám sát nhật ký hệ thống và trạng thái từng API Key theo thời gian thực.

2. **Cột danh sách chương bên trái (Chapter Sidebar — có thể thu gọn)**:
   - Hiển thị thông tin tóm tắt bộ truyện hiện tại, nút bấm nhanh vào **Tiến độ** và **Đọc tiếp Bookmark**.
   - Thanh tìm kiếm chương nhanh, nút mở công cụ **Toàn văn** (Tìm & Thay thế trên toàn bộ các chương) và nút **Tạo chương trắng mới (`+`)**.
   - Bộ lọc trạng thái chương: `Tất cả`, `Chưa dịch`, `Đã dịch`, `Đã duyệt`, `Có cảnh báo QA`, `Đánh dấu (Bookmark)`.
   - **Thanh điều khiển Hàng đợi Đa luồng (`1x` – `10x`)**: Cho phép chọn nhiều chương (hoặc chọn nhanh một dải chương từ chương `A` đến chương `B`) để chạy **Dịch (`N`)** hoặc **Biên tập AI (`N`)** song song.

3. **Không gian làm việc trung tâm (Main Workspace)**:
   - Chuyển đổi linh hoạt giữa 2 chế độ bằng nút **Đọc / Biên tập** trên thanh công cụ chương:
     - **Chế độ Biên tập (Editor Mode)**: Hỗ trợ 2 kiểu hiển thị:
       - **Song ngữ 1:1 Block-ID (`TITLE`, `P0001`..`Pxxxx`)**: Hiển thị từng đoạn nguyên tác chữ Hán bên trái khớp chính xác 1:1 với ô đoạn dịch tiếng Việt bên phải.
       - **Soạn thảo thuần (Plain Textarea)**: Hiển thị hai cột văn bản liền mạch kèm bộ công cụ trợ lý AI cho đoạn văn bôi đen.
     - **Chế độ Đọc truyện (Clean Justified Reader)**: Trình đọc sách điện tử căn đều hai bên (`text-align: justify`), ẩn toàn bộ chữ Hán và công cụ kỹ thuật để thưởng thức tác phẩm trọn vẹn.

4. **Thanh công cụ & Ngăn kéo phụ trợ (QA, Lịch sử Revision, Terminal)**:
   - Hiển thị báo cáo kiểm định chất lượng (QA), lịch sử các bản lưu (*Revisions*) của chương hiện tại và bảng điều khiển tùy biến giao diện đọc sách.

---

## 2. Quản lý Thư viện Đa Bộ Truyện & Bảng Tiến Độ

Bấm nút **Thư Viện** ở góc trái trên cùng (hoặc bấm nút **Tiến độ** trong Sidebar) để mở cửa sổ **Thư Viện Truyện & Tổng Quan Tiến Độ**.

### 2.1. Biểu đồ tiến độ toàn thư viện
- Hiển thị trực quan tỷ lệ hoàn thành của toàn bộ kho truyện theo 3 phân khúc:
  - 🔵 **Đã duyệt (Hoàn thiện)**: Các chương đã được biên tập và xác nhận hoàn tất.
  - 🟢 **Đã dịch (Chờ duyệt)**: Các chương đã có bản dịch tiếng Việt từ AI hoặc nhập ngoài nhưng chưa bấm *Duyệt*.
  - 🟠 **Chưa dịch (Raw gốc)**: Các chương mới nạp nguyên tác chữ Hán.
- Bạn có thể chuyển đổi giữa biểu đồ **Vòng (Donut)** hoặc **Tròn đặc (Pie)**, và **bấm trực tiếp vào từng lát cắt màu** để lọc danh sách những bộ truyện tương ứng.
- Chuyển đổi giữa chế độ xem **Kệ Sách (Cards)** và **Bảng Chi Tiết (Matrix)**.

### 2.2. Tạo mới, Chỉnh sửa & Chuyển đổi bộ truyện
- Bấm **Tạo Bộ Truyện Mới** để khai báo: Tên tiếng Việt, Tên nguyên tác chữ Hán, Tác giả, Thể loại (Tiên hiệp, Huyền huyễn, Đô thị, Khoa huyễn, Võng du, Lịch sử, Đồng nhân, Ngôn tình, Đam mỹ...), Trạng thái (*Đang dịch / Hoàn thành / Tạm dừng*), Mô tả tóm tắt và **Ảnh bìa** (tải ảnh từ máy tính để nhúng trực tiếp vào sách EPUB 3.3).
- Mỗi bộ truyện được gắn độc lập:
  - **1 Preset Dịch Thuật** riêng.
  - **1 Preset Biên Tập AI** riêng.
  - **1 Bộ Từ điển Tên riêng (Glossary)** riêng và công tắc bật/tắt đính kèm Glossary khi dịch.
- Trên mỗi thẻ truyện trong kệ sách, bạn có thể bấm:
  - **Mở bàn dịch**: Chuyển sang bộ truyện đó để làm việc.
  - **Đọc tiếp** *(nếu có Bookmark)*: Nhảy thẳng tới chương và vị trí cuộn đang đọc dở.
  - **Nhập chương**, **Xuất EPUB**, **Nhân bản bộ truyện**, **Ghim lên đầu (⭐)** hoặc **Xóa bộ truyện**.
  - **Khôi Phục `.ZIP`**: Nhập trọn vẹn một gói sao lưu `.ZIP` v5 vào thư viện mà không ảnh hưởng tới các truyện khác.

---

## 3. Cấu hình AI: Preset Dịch, Preset Biên Tập, Model & Pool 50 API Keys

Bấm nút **Preset & Model** trên thanh Header để mở trung tâm cấu hình trí tuệ nhân tạo. Cửa sổ này gồm **4 thẻ (Tabs)** chuyên biệt:

### 3.1. Thẻ 1 — Preset Dịch Thuật (`role: 'translation'`)
Quản lý các hồ sơ chỉ dẫn hệ thống (*System Instructions*) dùng khi dịch chương từ chữ Hán sang tiếng Việt.
- Hệ thống tích hợp sẵn 2 bộ Preset dịch thuật chuẩn hóa cho Gemini Interactions API:
  1. **Dịch Trung–Việt — Flash Đa Thể Loại (Bản Cô Đọng 1.14.1)** *(Mặc định)*: Bản tinh gọn tối ưu tốc độ phản hồi, tự động nhận diện thể loại (Cổ trang, Tu tiên, Đô thị, Khoa huyễn...) để áp dụng đại từ nhân xưng và nhịp văn phù hợp, chống văn phong "mùi dịch máy".
  2. **Dịch Truyện Trung–Việt — Flash / Flash-Lite (Bản Đầy Đủ 15 Mục 1.14.0)**: Bản quy tắc chi tiết 15 mục dành cho người dùng muốn kiểm soát sâu từng quy chuẩn từ vựng và dấu câu.
- Bạn có thể **Tạo Preset mới**, **Nhân bản**, **Chỉnh sửa nội dung prompt**, **Nhập/Xuất tệp `.MD`, `.TXT`, `.JSON`** hoặc bấm **Khôi phục gốc** bất cứ lúc nào.

### 3.2. Thẻ 2 — Preset Biên Tập AI (`role: 'editorial'`)
Quản lý các hồ sơ chỉ dẫn dùng riêng cho nút **AI biên tập** (trên thanh công cụ chương) và nút **Biên tập AI (`N`)** (trong hàng đợi đa luồng).
- Hệ thống tích hợp sẵn 2 bộ Preset biên tập:
  1. **Biên Tập Trung–Việt — Flash Đa Thể Loại (Bản Cô Đọng 1.14.1)** *(Mặc định)*: Chuyên rà soát bản dịch tiếng Việt đối chiếu với nguyên tác, tự động diệt sạch chữ Hán còn sót, xóa từ tiếng Anh lọt vô lý, bù đoạn bị khuyết và chuốt mượt câu văn mà không làm lệch số đoạn `P0001..Pxxxx`.
  2. **Biên Tập AI — Flash / Flash-Lite (Bản Đầy Đủ 10 Mục 1.14.0)**: Bản quy tắc biên tập chi tiết 10 mục.

### 3.3. Thẻ 3 — Chọn Model AI & Mức độ suy luận (Thinking Level)
- **Danh sách Model Gemini**: Chọn nhanh các dòng model thế hệ mới (như `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`...) hoặc bấm **Quét danh sách Model từ Google API** để cập nhật danh sách model mới nhất mà khóa của bạn hỗ trợ.
- **Mức độ suy luận (`Thinking Level`)**:
  - `minimal` (**Tối thiểu**): Phản hồi cực nhanh, tiết kiệm hạn mức tối đa. *(Lưu ý: Hệ thống tự động giữ `minimal` cho dòng model `flash-lite`, và tự động nâng lên `low` đối với các model không hỗ trợ `minimal` để tránh lỗi HTTP 400).*
  - `low` (**Thấp**): Cân bằng tốt giữa tốc độ và độ mượt câu văn.
  - `medium` (**Trung bình**): Dành cho các chương có nhiều thuật ngữ hoặc đối thoại phức tạp.
  - `high` (**Cao — Mặc định**): Suy luận sâu trước khi dịch, cho chất lượng văn phong tiểu thuyết cao nhất. *(Đối với chương rất dài `>= 6.000` chữ Hán, nếu lượt thử đầu tiên bị quá thời gian, hệ thống sẽ tự động hạ xuống `low` ở lượt thử kế tiếp để đảm bảo vượt qua mượt mà).*

### 3.4. Thẻ 4 — Xoay Vòng 50 API Keys & Chống Đứt Cáp 300s (Sợi Dây 1)
Đây là "động cơ" giúp bạn dịch hàng trăm chương truyện hoàn toàn miễn phí hoặc tốc độ cao mà không sợ nghẽn hạn mức (*Rate Limit 429*) hay lỗi *Gateway Timeout 300s*:
- **Dán danh sách tối đa 50 khóa Gemini API** (mỗi dòng 1 khóa `AIzaSy...`, hoặc ngăn cách bằng dấu phẩy).
- Bấm **Lưu Pool Khóa Lên Server**: Danh sách khóa được lưu bền vững trên máy chủ.
- **Cơ chế hoạt động tự động**:
  1. **Chia tải Round-Robin**: Khi bạn chạy dịch nhiều luồng (ví dụ 5 luồng hoặc 10 luồng song song), mỗi chương sẽ được phân bổ cho một khóa khác nhau trong Pool.
  2. **Tự động cô lập khóa chạm hạn mức (Cooldown)**: Nếu một khóa báo lỗi `429 Resource Exhausted`, hệ thống lập tức đánh dấu tạm nghỉ cho khóa đó và **chuyển ngay sang khóa khỏe mạnh tiếp theo trong cùng lượt dịch** (`maxRetries: 0` ở SDK để không bị treo ngầm) mà không làm gián đoạn chương đang dịch.
  3. **Bảo vệ kép chống đứt cáp 300s (Sợi dây 1)**:
     - **Cách 2 — Streaming Heartbeat**: Máy chủ phản hồi HTTP 200 ngay tại `0ms` và gửi xung nhịp khoảng trắng mỗi `10 giây` để giữ đường truyền trình duyệt luôn sống trong suốt quá trình AI suy luận.
     - **Cách 1 — Tự động làm mới Sợi dây 1 (`renewWire1`)**: Nếu một khóa thử thất bại khi tổng thời gian kết nối đã chạm ngưỡng `>= 90 giây`, máy chủ chủ động đóng kết nối cũ và báo trình duyệt mở tức thì một HTTP Request mới (kèm danh sách các khóa đã thử), đưa bộ đếm 300 giây của cổng mạng về `0s`.

---

## 4. Nhập chương nguyên tác (Raw) & Nhập bản dịch có sẵn

### 4.1. Nhập chương nguyên tác chữ Hán (Nút `Nhập Raw`)
Bấm nút **Nhập Raw** trên thanh Header, bạn có **4 phương thức** linh hoạt:
1. **Tải tệp `.TXT` / `.MD` (Kéo thả hoặc chọn nhiều tệp)**:
   - Hỗ trợ chọn hàng loạt tệp `.txt` rời rạc hoặc **1 tệp `.txt` gộp cả bộ truyện** (dung lượng lớn hàng chục MB).
   - **Tự động nhận diện bảng mã (Encoding)**: Tự động giải mã chuẩn `UTF-8`, `GB18030 / GBK` (tiếng Trung giản thể nội địa) và `Big5` (tiếng Trung phồn thể) — không bao giờ bị lỗi chữ tượng hình rác (*Mojibake*).
   - **Tự động tách chương thông minh bằng Regex**: Tự động nhận diện các dòng tiêu đề dạng `第1章...`, `第一章...`, `Chương 1:...`, `Chapter 1...` hoặc tách theo dung lượng ký tự nếu tệp không có tiêu đề chương.
2. **Tải gói nén `.ZIP` nhiều chương**: Tự động giải nén, sắp xếp đúng thứ tự số chương và nạp toàn bộ vào bộ truyện.
3. **Dán văn bản trực tiếp (Paste Raw)**: Dán nhanh một hoặc nhiều chương chữ Hán từ bộ nhớ tạm.
4. **Tải từ đường dẫn web (Fetch URL)**: Dán URL trang đọc truyện chữ Hán để máy chủ tự động bóc tách tiêu đề và nội dung chương.

### 4.2. Nhập bản dịch tiếng Việt có sẵn vào chương
Nếu bạn đã có sẵn bản dịch tiếng Việt từ nguồn khác và muốn đưa vào Studio để đối chiếu song ngữ `P0001..Pxxxx`, chạy biên tập AI hoặc đóng gói EPUB:
- Chọn chương cần nạp, bấm nút **Nhập bản dịch cả chương** trên thanh công cụ của chương (hoặc dùng nút **Dán Dịch** nhanh trên từng dòng chương ở cột bên trái).
- Hỗ trợ tải tệp `.txt`/`.md` hoặc dán trực tiếp văn bản tiếng Việt.
- Hệ thống sẽ tự động tách tiêu đề, phân đoạn `P0001..Pxxxx`, đối chiếu số lượng đoạn với nguyên tác chữ Hán và chạy kiểm định QA ngay lập tức.

---

## 5. Xây dựng Từ điển Tên riêng (Glossary) & Quét AI tự động (Pre-Scan)

Để tên nhân vật, địa danh, chiêu thức, cảnh giới và đại từ xưng hô **nhất quán 100%** từ chương 1 đến chương cuối, hãy bấm nút **Glossary** trên thanh Header.

### 5.1. Quét AI tự động trích xuất Glossary (Pre-Scan Chapters)
Trước khi bấm dịch hàng loạt một bộ truyện mới, bạn nên dùng tính năng **AI Quét Chương Đầu**:
1. Chọn số lượng chương đầu muốn quét (ví dụ: 5, 10 hoặc 20 chương đầu).
2. Bấm **Bắt Đầu Quét AI**: Hệ thống sẽ đọc nguyên tác chữ Hán, tự động phát hiện và lập danh sách:
   - **Nhân vật (`character`)**, **Địa danh (`location`)**, **Cảnh giới / Tu vi (`realm`)**, **Pháp bảo / Kỹ năng (`item` / `skill`)**, **Tổ chức / Tông môn (`organization`)**, **Danh hiệu (`title`)**...
   - Kèm theo **tần suất xuất hiện**, **bản dịch Hán-Việt chuẩn**, **cách xưng hô gợi ý** và **câu trích dẫn ngữ cảnh gốc**.
3. Bạn có thể xem trước, chỉnh sửa hoặc bấm **Lưu vào Glossary** chỉ với 1 cú nhấp chuột.

### 5.2. Quản lý & Nhập/Xuất Glossary thủ công
- Thêm nhanh thuật ngữ mới, lọc theo phân loại hoặc tìm kiếm theo chữ Hán / tiếng Việt.
- Hỗ trợ **Nhập / Xuất Glossary** qua định dạng `.CSV`, `.TSV` (dạng `Hán=Việt`) hoặc `.JSON`.
- **Công tắc Đính kèm Glossary**: Khi bật, hệ thống chỉ trích lọc thông minh những thuật ngữ thực sự xuất hiện trong chương đang dịch để gửi kèm cho AI, giúp tiết kiệm token và tăng độ chính xác tuyệt đối.

---

## 6. Dịch hàng loạt đa luồng (1x–10x) & Hàng đợi Biên tập AI

Tại cột danh sách chương bên trái (Sidebar), bạn có thể vận hành dây chuyền sản xuất tốc độ cao:

### 6.1. Chọn chương & Chạy hàng đợi
1. **Chọn chương**:
   - Tích chọn từng chương bằng hộp kiểm (Checkbox).
   - Hoặc nhập số chương bắt đầu – kết thúc vào ô **Chọn dải chương (`Từ` ... `Đến`)** rồi bấm **Chọn** (hoặc bấm **Chọn tất cả**).
2. **Chọn số luồng chạy song song (`1x` đến `10x`)**:
   - Nếu chỉ có 1 API Key: Nên chọn `1x` hoặc `2x`.
   - Nếu đã nạp từ 10 – 50 API Keys vào Pool: Có thể kéo lên `5x`, `8x` hoặc `10x` để dịch 10 chương cùng một lúc.
3. **Hai chế độ chạy hàng loạt**:
   - **Nút `Dịch (N)`**: Dịch mới toàn bộ các chương đã chọn theo Preset Dịch Thuật (`blocks-v1` — 1 Request = 100% toàn bộ chương theo cấu trúc JSON Block-ID).
   - **Nút `Biên tập AI (N)`**: Chạy biên tập AI hàng loạt cho các chương đã có bản dịch theo cơ chế **1 Request = 100% Toàn bộ chương (`realign_chapter` / `chapter-realign-edit-v1`)** để AI đối chiếu toàn bộ nguyên tác chữ Hán và bản dịch hiện tại, vừa làm sạch chữ Hán sót / từ tiếng Anh lọt / đoạn khuyết, vừa căn chỉnh lại khớp 1:1 từng mã đoạn `TITLE`, `P0001`..`Pxxxx` và chuốt mượt văn phong toàn chương.

### 6.2. Hủy tác vụ tức thời (1-Click Cancel)
- Trong khi đang dịch hoặc biên tập (dù là 1 chương lẻ hay hàng đợi 10 luồng), bạn có thể bấm nút **Dừng hàng đợi** (hoặc nút **Đang dịch... (Hủy)** / **Đang biên tập... (Hủy)** trên từng chương) để ngắt kết nối ngay lập tức và khôi phục trạng thái chương an toàn.

---

## 7. Bàn Biên Tập Song Ngữ 1:1 Block-ID (`TITLE`, `P0001`..`Pxxxx`)

Đây là trái tim của **Mặc Hương Các Studio**, giải quyết triệt để nỗi ám ảnh "AI dịch thiếu đoạn, gộp đoạn hoặc lệch dòng" thường gặp ở các công cụ dịch truyền thống.

### 7.1. Nguyên lý Bất biến 1:1 Block-ID
- Mỗi chương nguyên tác được đánh mã cố định:
  - `TITLE`: Tiêu đề chương.
  - `P0001`, `P0002`, `P0003`... `Pxxxx`: Từng đoạn văn trong thân chương.
- Khi AI dịch trả về JSON, hệ thống khớp chính xác từng mã `Pxxxx` vào đúng vị trí của nguyên tác. Nếu chẳng may AI bỏ sót đoạn `P0015`, chỉ riêng ô `P0015` hiện cảnh báo đỏ **"Thiếu bản dịch"**, còn `P0016` trở đi vẫn nằm **đúng hàng 100%** với nguyên tác chữ Hán bên trái (tuyệt đối không bị dồn hàng dây chuyền).

### 7.2. Các công cụ xử lý trên từng dòng Block `Pxxxx`
Tại mỗi dòng đoạn văn trong bảng **Song ngữ 1:1 Block-ID**, bạn có các nút thao tác tức thời ở góc phải của dòng:
- **`✨ AI Dịch Block`**: Gửi riêng đoạn `Pxxxx` đó (kèm ngữ cảnh đoạn liền trước và liền sau qua luồng `block_cleanup` / `block-cleanup-v1`) để AI dịch lại hoặc dọn sạch lỗi của riêng đoạn đó trong vài giây mà không đụng chạm tới các đoạn khác.
- **4 công cụ nắn dòng thủ công (khi bạn nhập bản dịch từ bên ngoài bị lệch số đoạn so với nguyên tác)**:
  - **`[Gộp ↓]`**: Gộp đoạn dịch hiện tại với đoạn dịch ngay bên dưới (dùng khi 1 đoạn gốc bị người dịch tách làm 2 đoạn).
  - **`[Tách ↵]`** *(hoặc đặt con trỏ chuột tại vị trí muốn ngắt câu trong ô tiếng Việt rồi nhấn phím tắt `Ctrl + Enter`)*: Tách đôi đoạn dịch hiện tại thành 2 đoạn riêng biệt (dùng khi 2 đoạn gốc bị gộp chung vào 1 ô).
  - **`[Đẩy ↓]`**: Chèn một ô trống tại dòng hiện tại để đẩy phần dịch từ dòng này trở xuống lùi 1 nhịp.
  - **`[Kéo ↑]`** *(hiện khi ô hiện tại đang trống)*: Xóa ô trống hiện tại để kéo toàn bộ các đoạn dịch bên dưới nhích lên 1 nhịp.
- **Nút tổng hợp trên thanh tiêu đề bảng Block-ID**:
  - Khi chương có đoạn bị sót Hán tự, lọt từ tiếng Anh, khuyết bản dịch hoặc lệch tổng số đoạn, nút **`AI Biên Tập & Dọn N Block Lỗi`** (hoặc **`AI Căn Lại & Biên Tập Cả Chương`**) sẽ xuất hiện ngay trên đầu bảng. Chỉ cần bấm 1 lần, AI sẽ đối chiếu toàn chương (`realign_chapter`) để sửa toàn bộ lỗi và căn chỉnh lại khớp 1:1 hoàn hảo.

### 7.3. Chế độ Soạn thảo thuần & Trợ lý AI cho đoạn bôi đen
Nếu bạn chuyển công tắc sang chế độ **Soạn thảo thuần**:
- Bạn có thể bôi đen bất kỳ câu/đoạn tiếng Việt nào để bật thanh công cụ **Trợ lý Biên tập AI**:
  - **Chuốt văn phong**: Viết lại câu văn mượt mà, giàu hình ảnh hơn.
  - **Sửa lỗi xưng hô**: Đồng bộ lại đại từ nhân xưng theo ngữ cảnh.
  - **Đề xuất 3 phương án dịch khác**: AI đưa ra 3 cách diễn đạt với sắc thái khác nhau để bạn chọn đè vào chỉ bằng 1 cú nhấp.

---

## 8. Kiểm định chất lượng tự động (QA Scanner) & Tìm/Thay thế Toàn văn

### 8.1. Bộ quét QA Đa Tiêu Chí (QA Scanner)
Mỗi khi một chương dịch xong hoặc được lưu, bộ máy QA tự động kiểm tra 5 nhóm lỗi và gắn huy hiệu trên thanh công cụ:
1. 🀄 **Sót Hán tự (`residual_chinese`)**: Phát hiện mọi ký tự chữ Hán còn sót lại trong tiêu đề hoặc nội dung tiếng Việt.
2. 🔤 **Lọt từ tiếng Anh (`leaked_english`)**: Phát hiện các từ tiếng Anh do AI sinh lỗi (như *suddenly, however, system, chapter...*), đồng thời thông minh bỏ qua tên riêng tiếng Việt không dấu hoặc các từ viết tắt hợp lệ.
3. 📖 **Vi phạm Glossary (`glossary_mismatch`)**: Cảnh báo khi nguyên tác chữ Hán có xuất hiện thuật ngữ trong Từ điển nhưng bản dịch tiếng Việt lại không dùng đúng từ đã quy định.
4. 📐 **Lệch số đoạn 1:1 (`formatting`)**: Cảnh báo khi tổng số đoạn dịch chưa khớp 1:1 với số đoạn nguyên tác.
5. 📏 **Câu văn quá dài (`long_sentence`)**: Cảnh báo những câu văn dài bất thường thiếu dấu ngắt câu.

### 8.2. Tìm & Thay Thế Toàn Văn (Full-Text Search & Replace)
Bấm nút **Toàn văn** trên thanh tìm kiếm của cột danh sách chương bên trái:
- Tìm kiếm một từ, cụm từ hoặc tên nhân vật trên **toàn bộ các chương** của bộ truyện (hoặc chỉ trong các chương đã chọn).
- Hỗ trợ tùy chọn: **Phân biệt chữ hoa/thường (`Aa`)**, **Khớp nguyên từ (`Whole Word`)** và **Biểu thức chính quy (`Regex`)**.
- Xem trước từng câu chứa từ khóa được tô sáng, tích chọn những vị trí muốn đổi và bấm **Thay thế tất cả**.
- Có nút **Hoàn tác (Undo)** ngay lập tức nếu bạn muốn khôi phục lại trạng thái trước khi thay thế.

---

## 9. Chế độ Đọc Truyện (Clean Justified Reader), Highlight & Bookmark

Bấm nút **Đọc** trên thanh công cụ chương để bước vào không gian thưởng thức tiểu thuyết chuyên nghiệp:

### 9.1. Trải nghiệm Đọc Căn Đều Hai Bên (`Clean Justified`)
- Toàn bộ thanh công cụ kỹ thuật và văn bản chữ Hán được ẩn đi, chỉ hiển thị tiêu đề và nội dung tiếng Việt đã căn đều hai bên lề (`text-align: justify`), thụt đầu dòng chuẩn sách in.
- Chuyển chương nhanh bằng nút **Chương trước / Chương sau** hoặc nhấn phím mũi tên `←` / `→` trên bàn phím.

### 9.2. Tùy biến Giao diện Đọc & Tải Phông Chữ Riêng (`Reader Appearance`)
Bấm nút **Giao diện đọc (Aa)** trong chế độ đọc để tùy chỉnh:
- **6 Chủ đề màu nền (Themes)**: Giấy Tuyên Thành ấm áp (*Warm Paper*), Trắng tinh khôi (*Pure Daylight*), Vàng cổ điển (*Sepia*), Xanh dịu mắt (*Sage Green*), Đêm tĩnh lặng (*Dark Charcoal*) và Đen tuyền OLED (*Midnight OLED*).
- **Kho phông chữ Tiếng Việt & Tải Font riêng**: Chọn sẵn *Literata, Noto Serif, Lora, Merriweather, Source Serif 4, Be Vietnam Pro, Plus Jakarta Sans, Inter, Roboto* — hoặc bấm **Tải phông chữ từ máy (`.ttf`, `.otf`, `.woff`, `.woff2`)** để đọc bằng bất kỳ bộ font yêu thích nào của bạn.
- Điều chỉnh **Cỡ chữ (`14px – 32px`)**, **Giãn dòng (`Line Height`)**, **Khoảng cách đoạn**, **Độ rộng trang đọc** và bật/tắt **Thụt đầu dòng đoạn văn**.

### 9.3. Tô sáng (Highlight 3 màu) & Đánh dấu trang (Bookmark)
- **Tô sáng & Ghi chú**: Bôi đen bất kỳ câu văn tâm đắc nào trong chế độ đọc để hiện bảng chọn **3 màu bút dạ quang** (*Vàng Hổ Phách, Xanh Ngọc Bích, Xanh Thanh Thiên*), thêm ghi chú cá nhân hoặc sao chép trích dẫn. Mở ngăn **Highlights** để xem lại danh sách toàn bộ trích dẫn trong truyện và bấm nhảy thẳng tới câu đó.
- **Đánh dấu trang (Bookmark)**: Bấm biểu tượng **Bookmark** để lưu lại chính xác chương và **tỷ lệ cuộn trang (`scrollRatio`)** hiện tại. Lần sau mở ứng dụng, bạn chỉ cần bấm **Đọc tiếp Bookmark** để quay lại đúng dòng đang đọc dở.

---

## 10. Xuất sách điện tử W3C EPUB 3.3, Tệp Gộp `.TXT` & Sao lưu `.ZIP` v5

Bấm nút **EPUB & Backup** trên thanh Header để mở trung tâm xuất bản và sao lưu:

### 10.1. Đóng gói sách điện tử chuẩn W3C EPUB 3.3 (`.epub`)
- Tạo tệp sách điện tử `.epub` hoàn chỉnh theo tiêu chuẩn **W3C EPUB 3.3** mới nhất, tương thích 100% với **Apple Books (iOS/macOS), Google Play Books, Amazon Kindle (Send to Kindle), Kobo, Moon+ Reader, Lithium, KOReader...**
- Tự động đóng gói:
  - **Trang bìa (Cover Image)** chất lượng cao (nếu chưa tải ảnh bìa riêng, hệ thống tự động vẽ một trang bìa nghệ thuật mang tên tác phẩm và tác giả).
  - **Mục lục tự động 2 chuẩn (`nav.xhtml` EPUB 3 + `toc.ncx` EPUB 2)** giúp mọi máy đọc sách đều nhận diện đầy đủ danh sách chương.
  - **Bảng kiểu dáng CSS chuẩn sách in**: Căn đều hai bên (`text-align: justify`), thụt đầu dòng đoạn văn, ngắt trang sạch sẽ giữa các chương.
- Tùy chọn phạm vi xuất: Xuất toàn bộ các chương đã có bản dịch, chỉ xuất các chương đã duyệt, hoặc xuất theo dải chương tùy chọn.

### 10.2. Xuất tệp văn bản `.TXT` (Gộp 1 tệp hoặc Tách rời từng chương)
- **Xuất 1 tệp `.TXT` gộp toàn truyện**: Tùy chọn chỉ xuất tiếng Việt, xuất Song ngữ (Hán – Việt xen kẽ từng đoạn), hoặc chỉ xuất Raw chữ Hán.
- **Xuất gói `.ZIP` chứa các tệp `.TXT` rời**: Mỗi chương là một tệp `.txt` riêng biệt được đánh số thứ tự chuẩn (`0001_Chuong-1.txt`...).

### 10.3. Sao lưu & Khôi phục Toàn bộ Dự án (`.ZIP` Backup v5)
- **Xuất gói Backup `.ZIP` v5**: Đóng gói toàn bộ dữ liệu của bộ truyện hiện tại (Thông tin truyện, Ảnh bìa, toàn bộ Chương Raw + Bản dịch + Lịch sử Revision + Báo cáo QA, Từ điển Glossary, các Preset chỉ dẫn và danh sách Highlight/Bookmark) vào 1 tệp `.zip` duy nhất.
- **Khôi phục từ gói Backup `.ZIP` v5**: Bạn có thể mang tệp `.zip` này sang máy tính khác và nạp lại ngay trong mục **EPUB & Backup** hoặc nút **Khôi Phục `.ZIP`** trong **Thư Viện**.

---

## 11. Trạm Giám Sát Hệ Thống (System Terminal Drawer)

Bấm nút **Terminal** ở góc phải trên cùng để mở bảng giám sát kỹ thuật theo thời gian thực:
- **Thẻ Nhật Ký Thời Gian Thực (Live Logs)**: Hiển thị chi tiết từng bước hệ thống đang thực hiện (Gửi yêu cầu dịch chương nào, dùng API Key số mấy, mất bao nhiêu mili-giây, nhận về bao nhiêu Block JSON, kết quả quét QA...). Hỗ trợ lọc theo mức độ (`INFO`, `SUCCESS`, `WARN`, `ERROR`), tìm kiếm log và xuất tệp nhật ký.
- **Thẻ Trạng Thái Pool 50 API Keys (Key Pool Health)**: Hiển thị bảng điều khiển trực quan cho toàn bộ các khóa trong Pool:
  - Khóa nào đang **Sẵn sàng (Active/Idle)**, khóa nào đang **Đang bận xử lý (Busy)**, khóa nào đang **Tạm nghỉ do chạm hạn mức 429 (Cooldown — kèm đồng hồ đếm ngược giây hồi phục)**.
  - Thống kê số lượt gọi thành công và số lần gặp lỗi của từng khóa.

---

## 12. Phím tắt bàn phím & Mẹo xử lý sự cố thường gặp

### 12.1. Các phím tắt tiện lợi
- **`Ctrl + S` (hoặc `Cmd + S` trên Mac)**: Lưu nhanh bản biên tập hiện tại của chương và tạo mốc lịch sử Revision mới.
- **`Ctrl + Enter`** *(khi đang đặt con trỏ trong ô tiếng Việt ở bảng Song ngữ 1:1 Block-ID)*: Tách đôi đoạn văn ngay tại vị trí con trỏ chuột thành 2 đoạn `Pxxxx` liên tiếp.
- **Phím mũi tên `←` / `→`** *(khi đang ở chế độ Đọc truyện)*: Chuyển nhanh sang Chương trước / Chương tiếp theo.
- **`Esc`**: Đóng các cửa sổ hộp thoại (Modal) đang mở.

### 12.2. Mẹo xử lý nhanh các tình huống thường gặp
1. **Khi đang dịch hàng loạt mà gặp báo lỗi `429 Resource Exhausted`**:
   - Đây là giới hạn số lượt gọi mỗi phút của gói Gemini API miễn phí. Bạn chỉ cần mở **Preset & Model -> Xoay Vòng 50 API Keys** và dán thêm nhiều khóa API từ các dự án Google AI Studio khác nhau. Hệ thống sẽ tự động xoay vòng qua các khóa rảnh rỗi mà không bị dừng hàng đợi.
2. **Khi chương dịch xong có cảnh báo "Lệch số đoạn" hoặc "Sót chữ Hán"**:
   - Chuyển sang bảng **Song ngữ 1:1 Block-ID**, bấm nút **`AI Biên Tập & Dọn N Block Lỗi`** (hoặc **`AI Căn Lại & Biên Tập Cả Chương`**) màu xanh ngọc ở đầu bảng (hoặc bấm nút **`AI biên tập`** trên thanh công cụ). AI sẽ tự động đối chiếu toàn chương và căn chỉnh lại khớp 1:1 chỉ sau vài giây.
3. **Khi nhập bản dịch có sẵn từ bên ngoài bị lệch dòng từ đoạn `P0010` trở đi**:
   - Kéo tới đúng dòng `P0010` trong bảng Song ngữ 1:1 Block-ID: nếu thấy 2 đoạn gốc bị gộp vào 1 ô tiếng Việt, hãy đặt chuột vào giữa hai câu rồi nhấn **`Ctrl + Enter`** (hoặc nút **`[Tách ↵]`**); toàn bộ các đoạn từ `P0011` trở xuống sẽ lập tức trượt vào đúng khớp 1:1 với nguyên tác chữ Hán!
