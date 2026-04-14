# ECS Staging Auto Scaling 調査レポート

**調査日時**: 2026-03-28 00:06 JST

---

## 1. 結論: スケールアウトしない原因

### 根本原因: CPU使用率がしきい値（55%）に遠く及んでいない

| 指標 | しきい値 | 実際の値（直近30分） |
|------|---------|-------------------|
| **CPU使用率（Average）** | **55%** | **0.2〜16%**（平均約4%） |
| **CPU使用率（Maximum）** | - | 最大30%程度 |
| **Memory使用率（Average）** | Memoryポリシーなし | 17〜36%（余裕あり） |

**E2Eテスト3環境が同時にアクセスしても、CPU使用率が55%に到達しない。**
これが「スケールアウトが発動しない」唯一かつ直接の原因。

---

## 2. Auto Scaling設定の詳細

### Staging Web（`pigeoncloud-staging-v2`）

| 設定項目 | 値 |
|---------|-----|
| スケーリングタイプ | Target Tracking（CPU） |
| ターゲット値（しきい値） | **55%** |
| スケールアウトCooldown | 60秒 |
| スケールインCooldown | 300秒 |
| 最小タスク数 | 1 |
| 最大タスク数 | 2 |
| 現在のタスク数 | **1** |
| タスク定義CPU | 2048（2 vCPU） |
| タスク定義Memory | 4096 MB |
| Memoryスケーリング | **なし（CPUのみ）** |

### CloudWatch Alarm状態

| アラーム | 状態 | 意味 |
|---------|------|------|
| AlarmHigh（スケールアウト用） | **OK** | CPU < 55% → スケールアウト不要と判断 |
| AlarmLow（スケールイン用） | **ALARM** | CPU < 49.5% → スケールインしたい状態（既にMin=1） |

### スケーリングアクティビティ履歴

- **最後のスケーリング**: 2026-03-26 03:53 → 1タスクにスケールイン
- **スケールアウトの履歴**: なし（ポリシー作成以来一度もスケールアウトしていない）

### Staging Queue（`pigeoncloud-staging-queue-v2`）

| 設定項目 | 値 |
|---------|-----|
| 現在のタスク数 | **1** |
| 最小/最大 | 1/3 |
| スケーリングタイプ | Step Scaling（キューカウント基準） |

---

## 3. タスクリソース分析

### なぜCPUが上がらないか

- タスク定義: **2 vCPU / 4GB Memory**
- 3つのE2Eテスト環境からのリクエストは、Webサーバー（PHP/Nginx）が処理
- PHPのリクエスト処理はI/O待ち（DB/ファイル）が大部分で、CPU集約型ではない
- **2 vCPUあれば、E2Eテスト程度のリクエスト数（5分あたり600〜1000リクエスト）は余裕で処理可能**

### ALBメトリクス

| 時間帯 | リクエスト数（5分間） | 平均レスポンスタイム | 最大レスポンスタイム |
|--------|---------------------|---------------------|---------------------|
| 14:37 | 613 | 0.20秒 | 0.62秒 |
| 14:42 | 561 | 0.21秒 | 1.30秒 |
| 14:47 | 968 | 0.21秒 | 0.56秒 |
| 14:52 | 163 | 0.19秒 | 0.42秒 |
| 14:57 | 219 | 0.17秒 | 0.49秒 |
| 15:02 | 403 | 0.22秒 | 0.76秒 |

**レスポンスタイムも安定（平均0.2秒）しており、1タスクで問題なく処理できている。**

---

## 4. RDS状態

| 項目 | 値 |
|------|-----|
| インスタンス | pigeoncloud-staging-mysql |
| クラス | db.t4g.large |
| CPU使用率（直近） | 5〜13%（通常時）、**38〜45%（15:03〜15:05のピーク）** |

RDSのCPUが一時的に43〜45%まで上がっている。E2Eテスト集中時にDBがボトルネックになる可能性はあるが、現時点では許容範囲内。

---

## 5. 推奨対策

### 対策A: しきい値の引き下げ（推奨）

現状のCPUベースのTarget Trackingを維持しつつ、しきい値を下げる。

```bash
# 現在: 55% → 推奨: 25〜30%
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/pigeoncloud-staging-cluster-v2/pigeoncloud-staging-v2" \
  --scalable-dimension "ecs:service:DesiredCount" \
  --policy-name "staging-cpu-scaling-policy" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 25.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    },
    "ScaleOutCooldown": 60,
    "ScaleInCooldown": 300
  }' \
  --profile lof --region ap-northeast-1
```

**効果**: CPU 25%超えでスケールアウト発動。ピーク時（14〜16%程度）ではまだ足りないが、テスト集中時に近づく可能性がある。

### 対策B: リクエスト数ベースのスケーリング追加（より確実）

CPUではなくALBのリクエスト数でスケーリングするポリシーを追加。

```bash
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/pigeoncloud-staging-cluster-v2/pigeoncloud-staging-v2" \
  --scalable-dimension "ecs:service:DesiredCount" \
  --policy-name "staging-request-scaling-policy" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 100.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ALBRequestCountPerTarget",
      "ResourceLabel": "app/pigeoncloud-staging-alb-new/aa36765ce92188be/targetgroup/pigeoncloud-staging-tg-new/383656a80e664c97"
    },
    "ScaleOutCooldown": 60,
    "ScaleInCooldown": 300
  }' \
  --profile lof --region ap-northeast-1
```

**効果**: 1タスクあたり100リクエスト/分を超えたら2タスクに。5分で968リクエスト = 約193リクエスト/分なのでピーク時にスケールアウトする。

### 対策C: Max容量の引き上げ

現在Max=2。E2Eテスト3環境が同時稼働するなら、Max=3〜4に引き上げるのも検討。

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "service/pigeoncloud-staging-cluster-v2/pigeoncloud-staging-v2" \
  --scalable-dimension "ecs:service:DesiredCount" \
  --min-capacity 1 \
  --max-capacity 4 \
  --profile lof --region ap-northeast-1
```

### 対策D: E2Eテスト時のみ手動スケールアウト（即効性あり）

テスト実行前にDesiredCountを直接上げる。

```bash
aws ecs update-service \
  --cluster pigeoncloud-staging-cluster-v2 \
  --service pigeoncloud-staging-v2 \
  --desired-count 2 \
  --profile lof --region ap-northeast-1
```

**注意**: Auto Scalingがスケールインするため、テスト中もCPUが低ければ5分後に1タスクに戻される。Min=2に変更する必要あり。

---

## 6. 推奨の優先順位

| 優先度 | 対策 | 理由 |
|--------|------|------|
| **1** | **対策B: リクエスト数ベース追加** | CPUが上がらない根本問題を回避。リクエスト負荷に直接対応 |
| **2** | 対策A: しきい値引き下げ（25%） | 簡単だが、PHP/NginxはI/Oバウンドなので効果が限定的 |
| **3** | 対策C: Max引き上げ（4） | スケールアウトが発動しても余裕を持たせる |
| **4** | 対策D: 手動スケール | 即効性はあるが運用負荷が増える |

---

## 7. まとめ

**スケールアウトしない原因は単純明快**: タスクのCPUリソース（2 vCPU）が十分に大きく、E2Eテスト3環境程度のリクエストではCPU使用率が最大でも16%程度にしか上がらない。しきい値55%にはまったく届かない。

**そもそもスケールアウトが必要かどうか**: レスポンスタイムは平均0.2秒で安定しており、1タスクでも十分処理できている。スケールアウトが必要なほどの負荷ではない可能性が高い。

もし「E2Eテスト時のレスポンス速度をさらに向上させたい」のであれば、**対策B（リクエスト数ベース）** を導入するのが最も効果的。
