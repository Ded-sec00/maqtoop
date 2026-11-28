# تشغيل اختبارات أول مسار شراء

تضيف catalog-options-http اختبار مصادر فروع التاجر وخيارات التجار والفروع للإدارة: دور ومنشأة وتفويض حالي، بحث وصفحات ومعرفات bigint، سحب مثبت أثناء انتظار قفل التفويض، وتسع حالات إلغاء جلسة بعد أقفال فعلية، دون تغيير النشر أو المال أو المخزون. الترحيلة catalog_options.sql بعد admin_review_list.sql؛ [العقد](../../docs/design/CATALOG_OPTIONS_API.md).

تضيفadmin-review-list-http البحث والتصفية والصفحات للإدارة فقط، وإلغاء الجلسة أثناء انتظار أقفال التاجر/الفرع/المؤشر، واتساقاللقطة أثناء تعديلمتزامن؛ يصبح الإجمالي86حالة. تثبتadmin_review_list.sql بعدcatalog_history.sql. [العقد](../../docs/design/ADMIN_REVIEW_LIST_API.md) و[النتائج](../../docs/verification/ADMIN_REVIEW_LIST_HTTP.md).

تضيف catalog-history-http سجل النسخ والمقارنة والعزل وسحب التفويض أثناء انتظار القفل، فيصبح الإجمالي85 حالة. تثبتcatalog_history.sql بعدmerchant_draft_list.sql. [العقد](../../docs/design/CATALOG_HISTORY_API.md) و[تقرير التحقق](../../docs/verification/CATALOG_HISTORY_HTTP.md).

تضيف merchant-drafts-list-http قائمة المسودات والبحث والتصفية والصفحات والعزل داخل المنشأة وبين التجار، وسحب الفرع أثناء انتظار القراءة وإبطال الجلسة. يصبح الإجمالي84 حالة. تثبت merchant_draft_list.sql بعد branch_permissions.sql؛ [النتائج](../../docs/verification/MERCHANT_DRAFT_LIST_HTTP.md).

تشمل المجموعة ثلاث حالات branch-permissions-http وbranch-permissions-reply-before وbranch-permissions-reply-after. تثبت branch_permissions.sql بعد catalog_drafts.sql، وتدير المنح والسحب عبر HTTP. تثبت رفض المسودة والصورة بعد سحب الفرع أثناء انتظار الأقفال، وتختبر التكرار وسباق النسخة القديمة وإلغاء جلسة الإدارة وفقد الرد. [العقد](../../docs/design/BRANCH_PERMISSIONS_API.md) و[تقرير التحقق](../../docs/verification/BRANCH_PERMISSIONS_HTTP.md).

يتطلب Node.js وnpm. الإصدارات مثبتة في package-lock.json. داخل جذر المشروع نفّذ:

```powershell
npm ci --prefix backend
npm ci --prefix db/first_purchase
npm test --prefix db/first_purchase
```

يشغّل الأمر محرك PostgreSQL 16.16 محمولًا على منفذ loopback متاح، ويهيئ cluster مستقلًا بترميز UTF-8 وكلمة مرور عشوائية لكل تشغيل. لكل حالة قاعدة جديدة باسم maqtoop_test_*، وتُمسح متغيرات MQ_ وPG الموروثة من بيئة كل عملية اختبار. مهلة كل عملية60ثانية وحد خرج1MiB، وأي فشل يوقف الحزمة برمز خروج غير صفري. تشغيل الطفل غير متزامن كي تبقى قنوات سجل PostgreSQL مقروءة أثناء حالاتSQL السلبية؛ لا تُخفض سجلات الأخطاء لإخفاء الفشل.

النتائج الفعلية تحفظ في results.json، ويوقف المشغّل المحرك في النهاية. يحتفظ بمجلد البيانات التجريبية تحت مجلد Windows المؤقت، ويذكر مساره في التقرير لتسهيل التشخيص. البيانات كلها مصطنعة.

الاختبارات تشمل سباق آخر قطعة، تحصيلًا متأخرًا، الاسترداد والبديل، السباق بينهما، التراجع، وفقد الرد والانقطاعات المتكررة. يعيد كل اختبار التحقق من المخزون والقيود ومستحق التاجر في المسار المحدد. إشعارات الدفع وإثبات الاستلام ورد المزود مصطنعة.

تفاصيل إصلاح نقاط المراجعة وحدود النسخة التجريبية في [تقرير المراجعة](../../docs/verification/FIRST_PURCHASE_REVIEW.md).

يفحص regressions.cjs تعدد التحصيلات وإعادة الحجز وفرض اتزان القيود. يثبت security.cjs الدوال المحدودة من security.sql ويستخدم سبعة اتصالات LOGIN فعلية، مع فحوص الرفض بين العملاء والتجار والمندوبين. تثبيت هذا المخطط مقصور على قواعد تجريبية فارغة.

يشمل التشغيل اختبار HTTP الفعلي في http.cjs. يثبت http.sql بعد المخطط والصلاحيات، ثم يشغّل backend ومزود sandbox محليين بهويات محدودة. التفاصيل في [تحقق HTTP](../../docs/verification/HTTP_PURCHASE.md).

تشمل المجموعة أيضًا ثلاث حالات للمرحلةA في catalog_drafts.cjs: المسودات والصور والمراجعة، وفقد الرد قبل التثبيت وبعده. تثبت catalog_drafts.sql بعد accounts.sql وتفحص الترحيلة الفاشلة والتفويض والصفحات والتكرار وإبطال الجلسات دون أثر على المخزون أو المال. [دليل نتائج الكتالوج](../../docs/verification/CATALOG_HTTP.md). شغّل `node scripts/ci/run-tests.mjs` من الجذر لفحص التقرير الجديد عبر حارس CI، بعد تثبيت اعتماديات backend والاختبارات.
