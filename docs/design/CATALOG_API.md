# عقد الكتالوج — المرحلة A

27 نوفمبر 2026. منفذ للمسودات والمراجعة الخاصة فقط. النشر وبيع المنتجات الجديدة غير مفعّلين. المتطلبات R01/R03/R08 والمهمة09؛ المرجع [التصميم](CATALOG_FIRST_HANDSET.md) و[خطة المرحلةA](../superpowers/plans/2026-11-27-catalog-first-handset.md).

## تشغيل المرحلة وحدودها

تثبت catalog_drafts.sql مرة واحدة بعد schema.sql وsecurity.sql وhttp.sql وaccounts.sql. تنشئ بيانات الكتالوج فقط وتضيف قيد ملكية مركبًا للفرع؛ لا تعيد إنشاء جدول شراء أو تغير كمية أو قيدًا ماليًا. الخادم لا يفتح المسارات إلا عند ضبط `catalog: {enabled: true}` في ملف إعداد خاص. لا يضيف الحساب لنفسه دورًا أو فرعًا. يجهّز المشغل تفويض principal_branch لدور merchant وللفرع الصحيح؛ يفحص التنفيذ الملكية حتى لو أُدخل تفويض خاطئ.

الأدوار تستخدم اتصالات LOGIN المحدودة الحالية. grants المطلوبة للمشغل: EXECUTE على purchase_api.catalog_read(text,jsonb,text) وcatalog_write(text,jsonb,text,text,text,bytea)، إضافة إلى صلاحيات الحسابات الموجودة. لا تمنح USAGE أو SELECT/UPDATE على schema catalog أو جداول الشراء للتطبيق. لا توجد وظيفة لمنح مستخدم تفويض فرع لنفسه.

## حقول المسودة

POST /v1/merchant/catalog/submissions ينشئ مسودة ويعيد201. جسم الطلب:

```json
{
  "branchId": "1",
  "category": "phone",
  "condition": "new",
  "brand": "Example",
  "model": "Model A",
  "storageGb": 128,
  "ramGb": 8,
  "color": "black",
  "suggestedTitle": "Example handset",
  "description": "Draft product",
  "supplyAmount": "54000.25",
  "currency": "YER",
  "initialQuantity": 1,
  "proposedWarranty": "",
  "mediaAssetIds": []
}
```

brand/model/color/suggestedTitle نصوص غير فارغة حتى200 حرف، وdescription حتى4000 حرف. السعة والذاكرة والكمية أعداد صحيحة موجبة حتى9 خانات. supplyAmount نص عشري موجب، حتى18 خانة صحيحة و8 كسرية؛ لا float للحساب المالي. التوريد هنا اقتراح داخلي لا يشغل تسعيرًا أو محاسبة. proposedWarranty اختياري حتى2000 حرف؛ يبقى وصف التاجر غير معتمد. mediaAssetIds اختياري حتى10UUID مختلفة، تملكها جلسة التاجر نفسها في الفرع نفسه. الجديد وYER هما نطاق هذه الشريحة؛ المستعمل والعملات الأخرى مرفوضة حاليًا.

كل حقل إضافي مثل merchantId أو role أو state أو rate أو salePrice أو storageKey مرفوض. لا يرسل العميل id، فهو من الخادم.

## مسارات التاجر والإدارة

| الطلب | المدخلات/النتيجة |
|---|---|
| GET /v1/merchant/catalog/submissions/{id} | قراءة مسودة مالكها المخول في الفرع، مع المحتوى والنسخة والقرارات |
| PATCH /v1/merchant/catalog/submissions/{id} | محتوى المسودة الكامل مع expectedVersion؛ ينشئ revision جديدة. لا ينقل الفرع |
| POST .../{id}/submit | expectedVersion فقط؛ draft→pending_review |
| POST .../{id}/withdraw | expectedVersion فقط؛ pending_review→withdrawn |
| GET /v1/admin/catalog/submissions | قائمة pending_review الداخلية، حد100 سجل لكل صفحة؛ nextCursor/hasMore للصفحة التالية عبر ?cursor=UUID. لا تقرر نشرًا |
| GET /v1/admin/catalog/submissions/{id} | قراءة خاصة للإدارة |
| POST /v1/admin/catalog/submissions/{id}/decision | decision وreason وexpectedVersion وexpectedRevision |
| GET /v1/catalog/handsets | للعميل الموثق فقط؛ items=[] وpublicationEnabled=false |

decision يقبل request_changes أوreject بسبب غير فارغ حتى2000 حرف. approve يعيد409/CATALOG_POLICY_NOT_CONFIGURED، ولا يحفظ قرارًا أو حالة approved أو مخزونًا. draft/update متاح في draft/changes_requested/withdrawn وينقل الحالة إلىdraft. لا تعديل لنسخة معلقة، ولا إعادة كتابة قرار تاريخي، ولا إعادة فتح rejected إلا بطلب جديد.

ترتيب قائمة المراجعة created_at ثمid، ويستمر المؤشر من آخر سجل في الصفحة، حتى لو راجعه المدير قبل طلب الصفحة التالية. يمكن قراءة تاريخ أي مسودة بمعرفها عبر مسار تفاصيل الإدارة. معاملات الاستعلام الأخرى أو مؤشر غير صالح مرفوضة؛ لا تفتح هذه الإضافة query parameters لبقية مسارات الشراء والحسابات.

submit لا يتطلب حسم سعر العميل أو ضمان الشركة؛ الاستجابة تذكر missingDependencies بقيم sale_price_policy وwarranty_policy. يجوز للمراجع طلب استكمال صور أو بيانات، لكن عدم رد الشركة ليس قبولًا تجاريًا ولا خطأ ينسب للتاجر.

## الجلسات والتزامن

كل المسارات تحتاج Bearer صالحًا، وكل POST/PATCH يحتاج Idempotency-Key من1 إلى200 حرفًا ضمن A–Z/a–z/0–9/:._-. مفتاح العملية مرتبط بالهوية والعملية والمورد وبصمة الجسم، ويضاف hash الصورة لبصمة الرفع. نفس النية تعيد النتيجة المخزنة نفسها؛ تغييرها بعد نجاح بنفس المفتاح409. الحقل version للعملية، وrevision لنسخة المحتوى؛ لا يفترض مساواتهما.

يقفل الكاتب مفتاح التكرار ثم مورد المسودة، ويعيد فحص الجلسة والحساب والفرع بعد انتظار الأقفال، حتى للنتيجة المخزنة. تغيير كلمة المرور والخروج من الجميع والإيقاف/إعادة التفعيل لا يحييان جلسة قديمة. سحب تفويض الفرع يمنع الإجراء المنتظر. القرار ومحتوى النسخة وسجل التدقيق والنتيجة المخزنة في نفس المعاملة.

## الصور الخاصة

POST /v1/merchant/catalog/media يستقبل bytes للصورة نفسها، Content-Type=image/png أوimage/jpeg، وX-Catalog-Branch-Id، مع Bearer وIdempotency-Key. يعيد201 وassetId وstate=private. الحد5MiB، و16 مليون بكسل، وصورة ثابتة واحدة، وحتى عمليتي تحقق متزامنتين. يفك sharp0.35.5 الصورة كاملة للتحقق من المحتوى؛ لا يكفي امتداد أو metadata فقط.

GET /v1/merchant/catalog/media/{id} لرافع الأصل المخول في الفرع، وGET /v1/admin/catalog/media/{id} للمراجع الإداري. تنزيل الأصل attachment مع no-store وnosniff. لا روابط عامة ولا paths أو filenames من العميل. عميل ومندوب وخدمة الدفع وتاجر آخر مرفوضون.

اختيار تقني موثق في [سجل التنفيذ](../verification/CATALOG_A_LEDGER.md): originals مخزنة bytea خاصة داخل PostgreSQL في هذه الشريحة، دون ملفات منفصلة أو خدمة إنتاج. عدم النشر مقصود؛ حذف العلامات المائية والبيانات الوصفية وتجهيز المشتق العام يأتي فيB ولا يعد منفذًا الآن.

## الأخطاء

400 للمدخلات والصور التالفة، 401 للجلسة غير الصالحة، 403 للدور/الفرع/المالك، 404 للمعرف المفقود، 409 لتكرار مفتاح بنية مختلفة أو نسخة/حالة قديمة أو غياب سياسة النشر، 413 لتجاوز حجم الصورة، 429 لازدحام التحقق من الصور، و503 لأخطاء قاعدة مؤقتة. تفاصيل SQL أو كلمات المرور أو bytes الصور لا تظهر في استجابة خطأ.

## عدم التأثير على البيع

لا توجد في المرحلةA دالة تولّد sku أوstock أوoffer من المسودة، ولا تضيفها إلى eligible_offer. لا حجز أو تحصيل أو مستحق أو قيد ينشأ منها. تبقى تجربة الشراء السابقة مستقلة، واختبار المقارنة يفحص جداولها كاملة قبل وبعد عمليات المرحلةA. لا تغير المرحلة قرار سعر البيع أو الضمان أو7291.
