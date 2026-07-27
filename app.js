// --- 初期フォールバックデータ（ダブルクリック起動などのCORS回避用） ---
const DEFAULT_DATABASE = {
  "year": 2026,
  "incomes": [
    { "id": "in_1_1", "month": 1, "source": "トライ（委託）", "type": "commission", "amount": 56540, "taxWithheld": 1715, "actualPaid": 54825, "isEstimated": false },
    { "id": "in_1_2", "month": 1, "source": "トライ（スタッフ）", "type": "salary", "amount": 3316, "taxWithheld": 0, "actualPaid": 3316, "isEstimated": false },
    { "id": "in_2_1", "month": 2, "source": "トライ（委託）", "type": "commission", "amount": 53350, "taxWithheld": 1634, "actualPaid": 51716, "isEstimated": false },
    { "id": "in_2_2", "month": 2, "source": "トライ（スタッフ）", "type": "salary", "amount": 11329, "taxWithheld": 0, "actualPaid": 11329, "isEstimated": false },
    { "id": "in_3_1", "month": 3, "source": "トライ（委託）", "type": "commission", "amount": 36350, "taxWithheld": 1113, "actualPaid": 35237, "isEstimated": false },
    { "id": "in_3_2", "month": 3, "source": "トライ（スタッフ）", "type": "salary", "amount": 12820, "taxWithheld": 0, "actualPaid": 12820, "isEstimated": false },
    { "id": "in_4_1", "month": 4, "source": "トライ（委託）", "type": "commission", "amount": 42020, "taxWithheld": 1287, "actualPaid": 40733, "isEstimated": false },
    { "id": "in_4_2", "month": 4, "source": "トライ（スタッフ）", "type": "salary", "amount": 9412, "taxWithheld": 0, "actualPaid": 9412, "isEstimated": false },
    { "id": "in_5_1", "month": 5, "source": "トライ（委託）", "type": "commission", "amount": 49450, "taxWithheld": 1514, "actualPaid": 47936, "isEstimated": false },
    { "id": "in_5_2", "month": 5, "source": "トライ（スタッフ）", "type": "salary", "amount": 7478, "taxWithheld": 0, "actualPaid": 7478, "isEstimated": false },
    { "id": "in_6_1", "month": 6, "source": "トライ（委託）", "type": "commission", "amount": 62050, "taxWithheld": 1900, "actualPaid": 60150, "isEstimated": false },
    { "id": "in_6_2", "month": 6, "source": "トライ（スタッフ）", "type": "salary", "amount": 6999, "taxWithheld": 0, "actualPaid": 6999, "isEstimated": false },
    { "id": "in_7_1", "month": 7, "source": "トライ（委託）", "type": "commission", "amount": 57100, "taxWithheld": 1748, "actualPaid": 55352, "isEstimated": true },
    { "id": "in_7_2", "month": 7, "source": "ふるさと創研", "type": "commission", "amount": 100000, "taxWithheld": 0, "actualPaid": 100000, "isEstimated": true },
    { "id": "in_10_1", "month": 10, "source": "TA（大学）", "type": "salary", "amount": 60000, "taxWithheld": 0, "actualPaid": 60000, "isEstimated": true },
    { "id": "in_10_2", "month": 10, "source": "ふるさと創研（見込み）", "type": "commission", "amount": 100000, "taxWithheld": 0, "actualPaid": 100000, "isEstimated": true }
  ],
  "expenses": [
    { "id": "ex_7_1", "month": 7, "category": "交通費", "source": "ふるさと創研", "amount": 5000, "memo": "打ち合わせ交通費（サンプル経費）" }
  ],
  "allowances": [
    { "id": "al_1", "month": 1, "source": "仕送り", "amount": 120000 },
    { "id": "al_2", "month": 2, "source": "仕送り", "amount": 170000 },
    { "id": "al_3", "month": 3, "source": "仕送り", "amount": 150000 },
    { "id": "al_4", "month": 4, "source": "仕送り", "amount": 400000 },
    { "id": "al_5", "month": 5, "source": "仕送り", "amount": 150000 },
    { "id": "al_6", "month": 6, "source": "仕送り", "amount": 100000 },
    { "id": "al_7", "month": 7, "source": "仕送り", "amount": 100000 }
  ]
};

// アプリケーションの状態管理
let appData = { ...DEFAULT_DATABASE };
let currentFilter = 'all';
let currentMonthFilter = 'all';
let isEditing = false;

// ページ読み込み時の処理
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setupEventListeners();
});

// アプリ初期化
async function initApp() {
    // 1. localStorage から読み込みを試みる
    const local = localStorage.getItem('m2_ledger_data');
    if (local) {
        try {
            appData = JSON.parse(local);
        } catch (e) {
            console.error('Local storage parse error, loading defaults', e);
            appData = { ...DEFAULT_DATABASE };
        }
    } else {
        // 2. localStorage が空の場合、data.json からのフェッチを試みる
        try {
            const response = await fetch('data.json');
            if (response.ok) {
                appData = await response.json();
                saveToLocalStorage();
            } else {
                throw new Error('data.json not found');
            }
        } catch (e) {
            console.log('Failed to fetch data.json (possibly local double-click). Using embedded fallback data.');
            appData = { ...DEFAULT_DATABASE };
            saveToLocalStorage();
        }
    }
    
    // UIを更新
    updateUI();
}

// データの保存
function saveToLocalStorage() {
    localStorage.setItem('m2_ledger_data', JSON.stringify(appData));
}

// UI全体の更新
function updateUI() {
    calculateAndRenderMetrics();
    renderTable();
    updateFormFieldsVisibility();
}

// 計算と各種メトリクスのレンダリング
function calculateAndRenderMetrics() {
    // --- 1. 実績（確定値）の集計 ---
    let realSalary = 0;
    let realCommission = 0;
    let realExpenses = 0;
    let realWithheld = 0;

    // 収入の集計
    appData.incomes.forEach(inc => {
        if (!inc.isEstimated) {
            if (inc.type === 'salary') realSalary += inc.amount;
            else if (inc.type === 'commission') realCommission += inc.amount;
            realWithheld += inc.taxWithheld || 0;
        }
    });

    // 経費の集計
    appData.expenses.forEach(exp => {
        // 経費はすべて実績としてカウント（予定の経費があれば別途区分）
        realExpenses += exp.amount;
    });

    // --- 2. 年間着地予測 (Projections) の算出 ---
    // TAやふるさとのような単発/不定期以外の「継続的」な収入（トライ）について、
    // まだ予定が入力されていない月（8-12月）に、1-6月実績の平均値を補完して予測を着地させる。
    
    // トライ委託の1-6月実績平均
    const triCommissions1to6 = appData.incomes.filter(i => i.source.includes('トライ') && i.type === 'commission' && i.month >= 1 && i.month <= 6);
    const triComAvg = triCommissions1to6.length ? triCommissions1to6.reduce((sum, i) => sum + i.amount, 0) / triCommissions1to6.length : 0;
    const triComWithheldAvg = triCommissions1to6.length ? triCommissions1to6.reduce((sum, i) => sum + (i.taxWithheld || 0), 0) / triCommissions1to6.length : 0;

    // トライスタッフの1-6月実績平均
    const triSalary1to6 = appData.incomes.filter(i => i.source.includes('トライ') && i.type === 'salary' && i.month >= 1 && i.month <= 6);
    const triSalAvg = triSalary1to6.length ? triSalary1to6.reduce((sum, i) => sum + i.amount, 0) / triSalary1to6.length : 0;

    // 7月〜12月において、それぞれの月にすでに「トライ」が登録されているか確認し、
    // なければ平均値で見込みを自動補完する（シミュレーション精度向上のため）
    let estSalary = 0;
    let estCommission = 0;
    let estWithheld = 0;

    // ユーザーが手動で登録した「予定(isEstimated: true)」の集計
    appData.incomes.forEach(inc => {
        if (inc.isEstimated) {
            if (inc.type === 'salary') estSalary += inc.amount;
            else if (inc.type === 'commission') estCommission += inc.amount;
            estWithheld += inc.taxWithheld || 0;
        }
    });

    // 継続ビジネス自動補完（8月〜12月）
    for (let m = 8; m <= 12; m++) {
        const hasCommission = appData.incomes.some(i => i.month === m && i.type === 'commission');
        const hasSalary = appData.incomes.some(i => i.month === m && i.type === 'salary');

        if (!hasCommission && triComAvg > 0) {
            estCommission += triComAvg;
            estWithheld += triComWithheldAvg;
        }
        if (!hasSalary && triSalAvg > 0) {
            estSalary += triSalAvg;
        }
    }

    // --- 3. 総合計の算出 ---
    const totalSalary = realSalary + estSalary;
    const totalCommission = realCommission + estCommission;
    const totalRevenue = totalSalary + totalCommission; // 年間見込み総収入
    const totalExpenses = realExpenses; // 年間経費（予定経費があれば加算するが一旦実績のみ）

    // 所得の計算
    // 給与所得 = max(0, 給与総額 - 550,000円)
    const totalSalaryIncome = Math.max(0, totalSalary - 550000);
    const realSalaryIncome = Math.max(0, realSalary - 550000);

    // 業務委託所得 = 業務委託総額 - 必要経費
    const totalCommissionIncome = Math.max(0, totalCommission - totalExpenses);
    const realCommissionIncome = Math.max(0, realCommission - totalExpenses);

    // 合計所得
    const totalIncome = totalSalaryIncome + totalCommissionIncome;
    const realIncome = realSalaryIncome + realCommissionIncome;

    const totalWithheld = realWithheld + estWithheld;

    // --- 4. UI 表示の更新 ---
    document.getElementById('valTotalRevenue').textContent = formatCurrency(totalRevenue);
    document.getElementById('valRealRevenue').textContent = formatCurrency(realSalary + realCommission);
    document.getElementById('valEstRevenue').textContent = formatCurrency(estSalary + estCommission);
    
    document.getElementById('valTotalExpenses').textContent = formatCurrency(totalExpenses);
    
    document.getElementById('valTotalIncome').textContent = formatCurrency(totalIncome);
    document.getElementById('valRealIncome').textContent = formatCurrency(realIncome);
    
    document.getElementById('valTotalWithheld').textContent = formatCurrency(realWithheld);

    // --- 5. 扶養上限メーターの描画 ---
    // (A) 親の税金扶養内 (所得48万円の壁)
    const taxLimit = 480000;
    const taxRealPct = Math.min(100, (realIncome / taxLimit) * 100);
    const taxTotalPct = Math.min(100, (totalIncome / taxLimit) * 100);

    const indTax = document.getElementById('indTaxLimit');
    const barTaxReal = indTax.querySelector('.progress-bar.real');
    const barTaxEst = indTax.querySelector('.progress-bar.estimated');
    const txtTaxVal = indTax.querySelector('.curr-val');
    const txtTaxStatus = indTax.querySelector('.status-msg');

    txtTaxVal.textContent = formatCurrency(totalIncome);
    barTaxReal.style.width = `${taxRealPct}%`;
    barTaxEst.style.width = `${Math.max(0, taxTotalPct - taxRealPct)}%`;
    barTaxEst.style.left = `${taxRealPct}%`;

    if (totalIncome > taxLimit) {
        indTax.classList.add('alert');
        const overAmt = totalIncome - taxLimit;
        txtTaxStatus.innerHTML = `⚠️ 扶養上限を <strong>${formatCurrency(overAmt)}</strong> 超過予測！経費を増やすか、仕事を調整してください。`;
    } else {
        indTax.classList.remove('alert');
        const marginAmt = taxLimit - totalIncome;
        txtTaxStatus.innerHTML = `🟢 扶養内（あと <strong>${formatCurrency(marginAmt)}</strong> 所得に余裕があります）`;
    }

    // (B) 社会保険の被扶養者 (年収130万円の壁 - 収入総額で判定)
    const socialLimit = 1300000;
    const socialRealPct = Math.min(100, ((realSalary + realCommission) / socialLimit) * 100);
    const socialTotalPct = Math.min(100, (totalRevenue / socialLimit) * 100);

    const indSocial = document.getElementById('indSocialLimit');
    const barSocReal = indSocial.querySelector('.progress-bar.real');
    const barSocEst = indSocial.querySelector('.progress-bar.estimated');
    const txtSocVal = indSocial.querySelector('.curr-val');
    const txtSocStatus = indSocial.querySelector('.status-msg');

    txtSocVal.textContent = formatCurrency(totalRevenue);
    barSocReal.style.width = `${socialRealPct}%`;
    barSocEst.style.width = `${Math.max(0, socialTotalPct - socialRealPct)}%`;
    barSocEst.style.left = `${socialRealPct}%`;

    if (totalRevenue >= socialLimit) {
        indSocial.classList.add('alert');
        const overAmt = totalRevenue - socialLimit;
        txtSocStatus.innerHTML = `⚠️ 社会保険扶養から外れる予測（過剰額: <strong>${formatCurrency(overAmt)}</strong>）`;
    } else {
        indSocial.classList.remove('alert');
        const marginAmt = socialLimit - totalRevenue;
        txtSocStatus.innerHTML = `🟢 保険扶養内（あと <strong>${formatCurrency(marginAmt)}</strong> 収入に余裕があります）`;
    }

    // --- 6. アドバイスの動的生成 ---
    generateAdvice(totalIncome, totalRevenue, taxLimit, socialLimit, totalExpenses, totalCommission);
}

// アドバイス生成エンジン
function generateAdvice(totalIncome, totalRevenue, taxLimit, socialLimit, totalExpenses, totalCommission) {
    const adviceDiv = document.getElementById('adviceContent');
    let html = '<ul>';

    if (totalIncome > taxLimit) {
        const requiredExpense = totalCommission - (taxLimit - Math.max(0, totalRevenue - totalCommission - 550000));
        const extraExpense = totalIncome - taxLimit;
        
        html += `<li><strong>所得税の扶養から外れる見込みです：</strong><br>
                現在のペースだと所得が <strong>${formatCurrency(totalIncome)}</strong> となり、制限の48万円を超えます。<br>
                年内にあと <strong>${formatCurrency(extraExpense)}</strong> 以上の「必要経費」を計上できれば、所得を48万円以下に抑え、親御さんの税金上の扶養をキープできます。</li>`;
        html += `<li><strong>経費計上のポイント：</strong><br>
                業務委託（トライ、ふるさと創研等）の活動で使用するインターネット代、指導に必要な専門書、打合せの交通費などを領収書とともに整理してください。</li>`;
    } else {
        const margin = taxLimit - totalIncome;
        html += `<li><strong>税金扶養（103万円の壁）はクリア見込みです：</strong><br>
                現在の予測所得は <strong>${formatCurrency(totalIncome)}</strong> で、制限の48万円まで <strong>${formatCurrency(margin)}</strong> の余裕があります。特別な調整をしなくても扶養にとどまれます。</li>`;
    }

    if (totalRevenue < socialLimit) {
        const margin = socialLimit - totalRevenue;
        html += `<li><strong>社会保険（130万円の壁）も安全圏です：</strong><br>
                年間の総収入予測は <strong>${formatCurrency(totalRevenue)}</strong> であり、社会保険の扶養から外れる130万円まであと <strong>${formatCurrency(margin)}</strong> 余裕があります。週の労働時間を増やす余裕も十分にあります。</li>`;
    } else {
        html += `<li><strong>⚠️ 社会保険（130万円の壁）警告：</strong><br>
                年間総収入が <strong>${formatCurrency(totalRevenue)}</strong> に達し、130万円の上限を超えそうです。社会保険の扶養を外れると、自分で国民健康保険や年金に加入する必要があり、年間で約15〜20万円の負担増となります。働くペースを少し抑えることを検討してください。</li>`;
    }

    // 源泉徴収に関するアドバイス
    const totalWithheldReal = appData.incomes.filter(i => !i.isEstimated).reduce((sum, i) => sum + (i.taxWithheld || 0), 0);
    if (totalWithheldReal > 0) {
        html += `<li><strong>確定申告による税金還付のチャンス：</strong><br>
                現在、トライ等の業務委託収入から <strong>${formatCurrency(totalWithheldReal)}</strong> が事前に源泉徴収（仮払い）されています。<br>
                来年2〜3月に簡易的な所得税の「確定申告」を行えば、この<strong>源泉徴収された額の大部分（または全額）があなたの口座へキャッシュバック（還付）</strong>されます。忘れずに申告しましょう！</li>`;
    }

    html += '</ul>';
    adviceDiv.innerHTML = html;
}

// 詳細テーブルの描画
function renderTable() {
    const tbody = document.getElementById('dataTableBody');
    tbody.innerHTML = '';

    // すべての取引（収入・経費・仕送り）を日付順/月順にマージする
    let list = [];

    appData.incomes.forEach(inc => {
        list.push({
            id: inc.id,
            month: inc.month,
            class: 'income',
            typeText: inc.type === 'salary' ? '収入 (給与)' : '収入 (委託)',
            typeClass: inc.type === 'salary' ? 'row-salary' : 'row-commission',
            source: inc.source,
            amount: inc.amount,
            taxWithheld: inc.taxWithheld || 0,
            actualPaid: inc.actualPaid || (inc.amount - (inc.taxWithheld || 0)),
            isEstimated: inc.isEstimated,
            raw: inc
        });
    });

    appData.expenses.forEach(exp => {
        list.push({
            id: exp.id,
            month: exp.month,
            class: 'expense',
            typeText: '必要経費',
            typeClass: 'row-expense',
            source: `${exp.source} (関連経費)`,
            amount: exp.amount,
            taxWithheld: null,
            actualPaid: exp.amount,
            isEstimated: false, // 経費は基本的に実績
            memo: exp.memo,
            raw: exp
        });
    });

    appData.allowances.forEach(al => {
        list.push({
            id: al.id,
            month: al.month,
            class: 'allowance',
            typeText: '仕送り',
            typeClass: 'row-allowance',
            source: al.source,
            amount: al.amount,
            taxWithheld: null,
            actualPaid: al.amount,
            isEstimated: false,
            raw: al
        });
    });

    // フィルタリング
    if (currentFilter !== 'all') {
        list = list.filter(item => item.class === currentFilter);
    }
    if (currentMonthFilter !== 'all') {
        const filterM = parseInt(currentMonthFilter);
        list = list.filter(item => item.month === filterM);
    }

    // ソート (月昇順、収入 -> 経費 -> 仕送りの順)
    list.sort((a, b) => {
        if (a.month !== b.month) return a.month - b.month;
        const classOrder = { 'income': 1, 'expense': 2, 'allowance': 3 };
        return classOrder[a.class] - classOrder[b.class];
    });

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-placeholder">該当するデータがありません。上のフォームから追加してください。</td></tr>`;
        return;
    }

    list.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = item.typeClass;

        // 金額のフォーマット
        const displayAmount = formatCurrency(item.amount);
        const displayWithheld = item.taxWithheld !== null ? formatCurrency(item.taxWithheld) : '-';
        const displayPaid = formatCurrency(item.actualPaid);
        const statusBadge = item.isEstimated 
            ? '<span class="badge-status est">予定</span>' 
            : '<span class="badge-status real">実績</span>';

        tr.innerHTML = `
            <td><strong>${item.month}月</strong></td>
            <td>${item.typeText}</td>
            <td>
                ${escapeHTML(item.source)}
                ${item.memo ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">メモ: ${escapeHTML(item.memo)}</div>` : ''}
            </td>
            <td class="text-right">${displayAmount}</td>
            <td class="text-right">${displayWithheld}</td>
            <td class="text-right" style="font-weight: 500;">${displayPaid}</td>
            <td>${statusBadge}</td>
            <td class="text-center">
                <button class="btn-action btn-edit" onclick="editItem('${item.id}', '${item.class}')" title="編集">✏️</button>
                <button class="btn-action btn-delete" onclick="deleteItem('${item.id}', '${item.class}')" title="削除">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// フォーム入力欄の表示制御
function updateFormFieldsVisibility() {
    const entryClass = document.getElementById('entryClass').value;
    const grpWithheld = document.getElementById('grpWithheld');
    const grpActualPaid = document.getElementById('grpActualPaid');
    const memoField = document.getElementById('memoField');
    const lblAmount = document.getElementById('lblAmount');

    if (entryClass === 'income-commission') {
        grpWithheld.style.display = 'block';
        grpActualPaid.style.display = 'block';
        memoField.style.display = 'none';
        lblAmount.textContent = '額面収入 (源泉徴収前)';
    } else if (entryClass === 'income-salary') {
        grpWithheld.style.display = 'none';
        grpActualPaid.style.display = 'none';
        memoField.style.display = 'none';
        lblAmount.textContent = '支給額 (額面)';
    } else if (entryClass === 'expense') {
        grpWithheld.style.display = 'none';
        grpActualPaid.style.display = 'none';
        memoField.style.display = 'block';
        lblAmount.textContent = '支出金額 (経費)';
    } else { // allowance (仕送り)
        grpWithheld.style.display = 'none';
        grpActualPaid.style.display = 'none';
        memoField.style.display = 'none';
        lblAmount.textContent = '仕送り金額';
    }
}

// フォームの送信（追加または更新）
function handleFormSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('editId').value;
    const month = parseInt(document.getElementById('entryMonth').value);
    const entryClass = document.getElementById('entryClass').value;
    const status = document.getElementById('entryStatus').value;
    const source = document.getElementById('entrySource').value.trim();
    const amount = parseInt(document.getElementById('entryAmount').value) || 0;
    const taxWithheld = parseInt(document.getElementById('entryWithheld').value) || 0;
    const memo = document.getElementById('entryMemo').value.trim();
    const isEstimated = status === 'estimated';

    const newId = id || `${entryClass.substring(0,2)}_${month}_${Date.now()}`;

    // 1. 各配列から既存アイテムを削除（更新の場合に備える）
    removeItemFromArrays(id);

    // 2. 分類に応じてデータを格納
    if (entryClass === 'income-commission') {
        appData.incomes.push({
            id: newId,
            month,
            source,
            type: 'commission',
            amount,
            taxWithheld,
            actualPaid: amount - taxWithheld,
            isEstimated
        });
    } else if (entryClass === 'income-salary') {
        appData.incomes.push({
            id: newId,
            month,
            source,
            type: 'salary',
            amount,
            taxWithheld: 0,
            actualPaid: amount,
            isEstimated
        });
    } else if (entryClass === 'expense') {
        appData.expenses.push({
            id: newId,
            month,
            category: '一般経費', // 簡易的に一律
            source: source,
            amount,
            memo
        });
    } else if (entryClass === 'allowance') {
        appData.allowances.push({
            id: newId,
            month,
            source: '仕送り',
            amount
        });
    }

    // 保存と再描画
    saveToLocalStorage();
    updateUI();
    resetForm();
}

// 配列からアイテム削除のヘルパー
function removeItemFromArrays(id) {
    if (!id) return;
    appData.incomes = appData.incomes.filter(item => item.id !== id);
    appData.expenses = appData.expenses.filter(item => item.id !== id);
    appData.allowances = appData.allowances.filter(item => item.id !== id);
}

// 編集ボタン押下時
window.editItem = function(id, itemClass) {
    let item = null;
    let formClass = '';

    if (itemClass === 'income') {
        item = appData.incomes.find(i => i.id === id);
        formClass = item.type === 'commission' ? 'income-commission' : 'income-salary';
    } else if (itemClass === 'expense') {
        item = appData.expenses.find(i => i.id === id);
        formClass = 'expense';
    } else if (itemClass === 'allowance') {
        item = appData.allowances.find(i => i.id === id);
        formClass = 'allowance';
    }

    if (!item) return;

    // フォームに値をセット
    document.getElementById('editId').value = item.id;
    document.getElementById('entryMonth').value = item.month;
    document.getElementById('entryClass').value = formClass;
    document.getElementById('entryStatus').value = item.isEstimated ? 'estimated' : 'real';
    document.getElementById('entrySource').value = itemClass === 'expense' ? item.source.replace(' (関連経費)', '') : item.source;
    document.getElementById('entryAmount').value = item.amount;
    document.getElementById('entryWithheld').value = item.taxWithheld || '';
    document.getElementById('entryMemo').value = item.memo || '';

    // モード切り替え
    isEditing = true;
    document.getElementById('formTitle').textContent = '取引データの編集';
    document.getElementById('btnSubmitEntry').textContent = '更新する';
    document.getElementById('btnCancelEdit').style.display = 'inline-block';

    updateFormFieldsVisibility();
    
    // 入力フォームまでスクロール
    document.querySelector('.entry-form-card').scrollIntoView({ behavior: 'smooth' });
};

// 削除ボタン押下時
window.deleteItem = function(id, itemClass) {
    if (confirm('この明細を削除してもよろしいですか？')) {
        removeItemFromArrays(id);
        saveToLocalStorage();
        updateUI();
    }
};

// フォームのリセット
function resetForm() {
    document.getElementById('entryForm').reset();
    document.getElementById('editId').value = '';
    
    // モード初期化
    isEditing = false;
    document.getElementById('formTitle').textContent = '取引データの追加';
    document.getElementById('btnSubmitEntry').textContent = '追加する';
    document.getElementById('btnCancelEdit').style.display = 'none';

    updateFormFieldsVisibility();
}

// イベントリスナーのセットアップ
function setupEventListeners() {
    // フォーム送信
    document.getElementById('entryForm').addEventListener('submit', handleFormSubmit);

    // 編集キャンセル
    document.getElementById('btnCancelEdit').addEventListener('click', resetForm);

    // 分類変更時の入力欄表示制御
    document.getElementById('entryClass').addEventListener('change', updateFormFieldsVisibility);

    // 額面と源泉徴収からの手取り自動計算
    const entryAmount = document.getElementById('entryAmount');
    const entryWithheld = document.getElementById('entryWithheld');
    const entryActualPaid = document.getElementById('entryActualPaid');

    const updateActualPaid = () => {
        const amt = parseInt(entryAmount.value) || 0;
        const wth = parseInt(entryWithheld.value) || 0;
        entryActualPaid.value = amt - wth >= 0 ? amt - wth : 0;
    };
    entryAmount.addEventListener('input', updateActualPaid);
    entryWithheld.addEventListener('input', updateActualPaid);

    // フィルターボタン制御
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentFilter = e.target.getAttribute('data-filter');
            renderTable();
        });
    });

    // 月ボタン制御
    const monthBtns = document.querySelectorAll('.month-btn');
    monthBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            monthBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentMonthFilter = e.target.getAttribute('data-month');
            renderTable();
        });
    });

    // エクスポート機能
    document.getElementById('btnExport').addEventListener('click', () => {
        const dataStr = JSON.stringify(appData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        
        const link = document.createElement('a');
        link.download = `M2_Income_Data_${new Date().getFullYear()}.json`;
        link.href = url;
        link.click();
        
        URL.revokeObjectURL(url);
    });

    // インポート機能
    const fileInput = document.getElementById('fileInput');
    document.getElementById('btnImport').addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const parsedData = JSON.parse(evt.target.result);
                if (parsedData.incomes && parsedData.expenses && parsedData.allowances) {
                    appData = parsedData;
                    saveToLocalStorage();
                    updateUI();
                    alert('データをインポートしました！');
                } else {
                    alert('無効なファイル形式です。家計簿データ（JSON）を選択してください。');
                }
            } catch (err) {
                alert('JSONファイルの読み込みに失敗しました。');
            }
        };
        reader.readAsText(file);
    });
}

// ユーティリティ: 通貨フォーマット
function formatCurrency(num) {
    return '¥ ' + Math.round(num).toLocaleString();
}

// ユーティリティ: HTMLエスケープ
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// スムーズスクロール
window.scrollToSection = function(id) {
    document.getElementById(id).scrollIntoView({ behavior: 'smooth' });
};
