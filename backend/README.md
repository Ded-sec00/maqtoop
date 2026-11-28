# أول مسار شراء عبر HTTP

يشغل هذا المجلد عقد أول شراء باستخدام Node.js وPostgreSQL. يعتمد التشغيل على مخطط التجربة ودوال الصلاحيات وامتداد HTTP في db/first_purchase. يحتوي المخطط على جلسات مصطنعة وهويات اتصال محدودة، وتُنفذ الاختبارات عبر PostgreSQL فعلي وخادم دفع تجريبي.

## التشغيل المحلي

من جذر المستودع:

```powershell
npm ci --prefix backend
$env:MAQTOOP_API_CONFIG = 'C:/private/maqtoop-api.json'
npm start --prefix backend
```

يقرأ start.mjs ملف إعداد خاصًا خارج المستودع. يتضمن الإعداد database مع host وport وdatabase، وgateway مع بيانات اتصال هوية فحص الجلسة، وactors بخريطة LOGIN إلى بيانات اتصال كل هوية، وserviceLogin وserviceToken وهوية الخدمة، وprovider مع baseUrl وwebhookSecret. يحدد listen عنوان الربط ومنفذه، ويضبط workerIntervalMs فترة عامل المهام. الرابط الافتراضي محلي ومنفذ التشغيل يختاره النظام.

ينشئ تجهيز قاعدة الاختبار LOGIN لكل دور ورموز Bearer عشوائية وبصماتها في http_session. تقتصر هوية gateway على فحص الجلسة، وتنفذ كل عملية من اتصال الهوية المحدودة الموافق لها. تحفظ بيانات الاتصال والرموز خارج Git. تسجيل المستخدمين واستعادة الحسابات لهما مسار تنفيذ لاحق.

يدعم createApi(config) التشغيل داخل اختبار الربط. تعيد listen({host,port}) عنوان الخادم، وتوقف close() العامل والخادم ومجمعات الاتصالات. تمرر الاختبارات workerIntervalMs: 0 وتستدعي runWorkerOnce() للتحكم في إرسال المهمة التجريبية.

## بروتوكول الطلب

تتطلب مسارات v1 رأس Authorization: Bearer مع رمز الجلسة. تتطلب POST أيضًا Content-Type: application/json وIdempotency-Key ثابتًا عند الإعادة. تحمل المبالغ نصوصًا عشرية. تُرفض الحقول الزائدة. تعرض استجابات الأخطاء code وmessage وrequestId، وتعود معرفات الموارد في الجسم.

مسار مزود الاختبار هو POST /internal/payment-providers/sandbox/events. يوقّع المزود جسم JSON الخام باستخدام HMAC-SHA256 ويضع القيمة hex في x-provider-signature. يستخدم الحدث مرجع المحاولة ووقت التحصيل والمبلغ والعملة، وتتحقق الدوال من ارتباطها قبل القيد. تستخدم الخدمة جلسة مخصصة محفوظة في الإعداد.

يرسل العامل POST إلى payments أو refunds تحت provider.baseUrl. الجسم مهمة Outbox، والرأس Idempotency-Key يحمل providerKey المحفوظ. يستلزم قبول المزود 202، ثم تعلم المهمة أنها أرسلت. عند تعذر الاتصال تبقى المهمة مؤجرة حتى إعادة إرسال نفس المفتاح، ويظل التأكيد المالي معتمدًا على إشعار المزود أو المطابقة.

الخطافات beforeCommit وafterCommit تقبلها createApi من برنامج الاختبار فقط لمحاكاة قطع الاتصال. لا توجد مسارات HTTP لتفعيلها.

## مطابقة العمليات المرسلة

ترجع next_http_job مهمة action=send أو action=reconcile. بعد قبول إرسال الأمر، تحدد القاعدة موعد مطابقة العملية. يرسل العامل للمطابقة GET إلى operations/{providerKey} تحت عنوان المزود، ويتوقع استجابة 200 فيها state بقيمة pending أو unknown أو failed أو succeeded.

كل استجابة حالة تحمل providerKey وstate وsignature بنص hex، وتضيف event عند succeeded. يثبت العامل تطابق providerKey مع المفتاح المحفوظ، ثم يتحقق من HMAC-SHA256 على JSON ذي مفاتيح المستوى الأعلى مرتبة ترتيبًا أبجديًا مع استبعاد signature. لا يسمح لنتيجة pending أو unknown أو failed بتعديل الحالة قبل نجاح نفس التحقق. عند succeeded يثبت أيضًا تطابق attemptId أو refundId داخل event مع المهمة، ثم يمرر الحدث للدالة المالية نفسها. عند pending أو unknown يعاد جدولة المطابقة دون إرسال أمر تحصيل جديد. تعتمد معالجة failed على سجل الحالة داخل قاعدة البيانات. يظل فشل الشبكة أو التوقيع قابلًا لإعادة المطابقة بالمفتاح المحفوظ.

## الحسابات

أضف accounts.sql بعد ترحيلات الشراء، ثم جهّز أول حساب إدارة بواسطة provision-account.mjs من ملف خاص خارج Git. تدعم auth.mjs الدخول والخروج وتغيير كلمة المرور وإدارة الحسابات. العقد وحدود معرّف الدخول والجلسة في [دليل الحسابات](../docs/design/ACCOUNTS_API.md). تُربط الحسابات بهويات LOGIN المهيأة في إعداد الخادم.

## مسودات الكتالوج — المرحلة A

لتوسيع قائمة مراجعة الإدارة ثبتadmin_review_list.sql بعدcatalog_history.sql، وامنحLOGIN الإدارة EXECUTE علىpurchase_api.catalog_review_list(jsonb,text). المسارGET /v1/admin/catalog/submissions يدعمq/merchantId/branchId/state/limit/cursor معإعادة فحصالجلسة بعدأقفال التصفية والمؤشر. يبقى الافتراضيpending_review وحد100 ومؤشرUUID القديم. [العقد](../docs/design/ADMIN_REVIEW_LIST_API.md)، دوننشر أوبيع.

لسجل النسخ والمقارنة ثبت catalog_history.sql بعد merchant_draft_list.sql، وامنح LOGIN التاجر والإدارة EXECUTE على purchase_api.catalog_history(text,jsonb,text) فقط. GET .../revisions و.../revisions/{revision} و.../compare?from=1&to=2 محمية بالمالك والفرع والجلسة الحالية بعد الانتظار. [العقد](../docs/design/CATALOG_HISTORY_API.md)؛ لا تغيير لقفل النشر والبيع.

لقائمة مسودات التاجر ثبت merchant_draft_list.sql بعد branch_permissions.sql، وامنح LOGIN التاجر EXECUTE على purchase_api.merchant_catalog_list(jsonb,text). GET /v1/merchant/catalog/submissions يقبل q/state/branchId/limit/cursor فقط، ولا يقرأ سوى مسودات صاحب الجلسة في فروعه المخولة. [العقد](../docs/design/CATALOG_API.md) يوضح المؤشر وسحب التفويض أثناء الانتظار. لا يتغير قفل النشر والبيع.

بعد catalog_drafts.sql أضف branch_permissions.sql لإدارة منح وسحب الفروع عبر HTTP بدل حذف صف التفويض. يحتاج LOGIN الإداري EXECUTE على branch_access_read(text,jsonb,text) وbranch_access_write(text,jsonb,text,text,text). لا تمنح صلاحيات جداول مباشرة. [عقد الفروع والترحيل والرجوع](../docs/design/BRANCH_PERMISSIONS_API.md) يوضح النسخ والتكرار وإعادة فحص الصلاحيات بعد الأقفال. يظل catalog.enabled هو مفتاح فتح هذه المسارات الخاصة، دون نشر أو بيع.

أضف db/first_purchase/catalog_drafts.sql بعد accounts.sql، واضبط catalog.enabled=true في إعداد الخادم لفتح المسارات الخاصة. يجهّز المشغل تفويض purchase_api.principal_branch ويمنح EXECUTE للدالتين catalog_read وcatalog_write المحددتين في [عقد الكتالوج](../docs/design/CATALOG_API.md). الحساب أو دور التاجر وحده لا يمنح حق فرع. الصور الخاصة bytea في PostgreSQL وتتحقق بواسطة sharp بإصدار مثبت. لا نشر للعميل أو توليد مخزون/عرض بيع من هذه المسودات، وapprove موقوف حتى السياسات المعتمدة.
