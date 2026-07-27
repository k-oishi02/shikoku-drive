import re

html_path = r'c:\家計簿\travel_guide.html'

with open(html_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

old_script_pattern = re.compile(r'// Warikan System Script.*// Initial render\s*renderExpenses\(\);', re.DOTALL)

new_script = """// Real-Time Online Synchronized Warikan System
        const SYNC_ENDPOINT = "https://kvdb.io/shikoku_drive_2026_aoi_kotaro_v1/expenses";

        const defaultInitialExpenses = [
            { payer: 'あおい', name: 'ANA航空券 (2名分)', amount: 42280 },
            { payer: 'こうたろう', name: 'トヨタレンタカー (乗捨て込)', amount: 33440 },
            { payer: 'こうたろう', name: '1泊目: 高松国際ホテル', amount: 11520 },
            { payer: 'こうたろう', name: '2泊目: ダイワロイネットホテル松山', amount: 13530 }
        ];

        let expenses = defaultInitialExpenses;

        async function fetchRemoteExpenses() {
            try {
                const response = await fetch(SYNC_ENDPOINT);
                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data) && data.length > 0) {
                        expenses = data;
                        renderExpensesUI();
                    }
                }
            } catch (e) {
                console.log('Sync offline fallback');
            }
        }

        async function saveRemoteExpenses() {
            try {
                await fetch(SYNC_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(expenses)
                });
            } catch (e) {
                console.log('Save offline fallback');
            }
        }

        function renderExpensesUI() {
            const tbody = document.getElementById('warikan-tbody');
            if (!tbody) return;
            tbody.innerHTML = '';
            
            let totalAoi = 0;
            let totalKotaro = 0;

            expenses.forEach((item, index) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${item.payer}</strong></td>
                    <td>${item.name}</td>
                    <td>${item.amount.toLocaleString()} 円</td>
                    <td><button class="btn-delete" onclick="deleteExpense(${index})">✕</button></td>
                `;
                tbody.appendChild(tr);

                if (item.payer === 'あおい') {
                    totalAoi += item.amount;
                } else if (item.payer === 'こうたろう') {
                    totalKotaro += item.amount;
                }
            });

            // Calculate settlement (Aoi vs Kotaro)
            const diff = totalAoi - totalKotaro;
            const summaryText = document.getElementById('warikan-summary-text');
            const resultAmount = document.getElementById('warikan-result-amount');

            if (expenses.length === 0) {
                summaryText.innerText = '立替データはまだありません';
                resultAmount.innerText = '0 円';
            } else if (diff > 0) {
                const payBack = Math.round(diff / 2);
                summaryText.innerText = 'こうたろう ➔ あおい へ支払う精算額:';
                resultAmount.innerText = `${payBack.toLocaleString()} 円`;
            } else if (diff < 0) {
                const payBack = Math.round(Math.abs(diff) / 2);
                summaryText.innerText = 'あおい ➔ こうたろう へ支払う精算額:';
                resultAmount.innerText = `${payBack.toLocaleString()} 円`;
            } else {
                summaryText.innerText = 'ピッタリ均等（精算なし）';
                resultAmount.innerText = '0 円';
            }
        }

        function addExpense() {
            const payer = document.getElementById('payer').value;
            const nameInput = document.getElementById('item-name');
            const amountInput = document.getElementById('item-amount');

            const name = nameInput.value.trim() || '立替項目';
            const amount = parseInt(amountInput.value);

            if (isNaN(amount) || amount <= 0) {
                alert('正しい金額を入力してください');
                return;
            }

            expenses.push({ payer, name, amount });
            nameInput.value = '';
            amountInput.value = '';
            renderExpensesUI();
            saveRemoteExpenses();
        }

        function deleteExpense(index) {
            expenses.splice(index, 1);
            renderExpensesUI();
            saveRemoteExpenses();
        }

        function clearWarikan() {
            if (confirm('立替データを初期化しますか？')) {
                expenses = [];
                renderExpensesUI();
                saveRemoteExpenses();
            }
        }

        // Initialize & Auto-Sync Every 4 Seconds Live
        renderExpensesUI();
        fetchRemoteExpenses();
        setInterval(fetchRemoteExpenses, 4000);"""

content = old_script_pattern.sub(new_script, content)

with open(html_path, 'w', encoding='utf-8-sig') as f:
    f.write(content)

print("Updated JS with live sync!")
