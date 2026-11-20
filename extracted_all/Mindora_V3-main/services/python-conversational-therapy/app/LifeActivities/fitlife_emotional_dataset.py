
import pandas as pd
import joblib
import os
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

# ===================
# 1. LOAD & CLEAN DATA
# ===================
def load_dataset(csv_path=None):
    csv_path = csv_path or os.getenv("FITLIFE_DATASET_PATH", "fitlife_emotional_dataset.csv")
    df = pd.read_csv(csv_path)
    df.columns = df.columns.str.strip().str.lower().str.replace(' ', '_')
    df['mood_change'] = df['mood_after_(1-10)'] - df['mood_before_(1-10)']
    return df

# ===================
# 2. ANALYZE PATTERNS
# ===================
def top_mood_boosters(df, top_n=10):
    return df.groupby('activity').agg(avg_mood_change=('mood_change', 'mean')).sort_values(by='avg_mood_change', ascending=False).head(top_n)

def top_stress_reducers(df, top_n=10):
    return df.groupby('activity').agg(avg_stress=('stress_level_(1-10)', 'mean')).sort_values(by='avg_stress').head(top_n)

def recommend_by_stats(df, mood_before=4, stress_level=7, emotion_filter=None, top_n=5):
    filtered = df.copy()
    if emotion_filter:
        filtered = filtered[filtered['primary_emotion'].str.lower().str.contains(emotion_filter.lower())]
    filtered = filtered[
        (filtered['mood_before_(1-10)'] <= mood_before + 1) &
        (filtered['mood_before_(1-10)'] >= mood_before - 1) &
        (filtered['stress_level_(1-10)'] >= stress_level - 2)
    ]
    return filtered.groupby('activity').agg(avg_mood_boost=('mood_change', 'mean')).sort_values(by='avg_mood_boost', ascending=False).head(top_n)

# ===================
# 3. TRAIN ML MODEL
# ===================
def prepare_ml_data(df):
    features = ['activity_category', 'sub-category', 'intensity', 'mood_before_(1-10)', 'stress_level_(1-10)']
    target = 'primary_emotion'
    encoders = {}

    for col in features:
        if df[col].dtype == 'object':
            le = LabelEncoder()
            df[col] = le.fit_transform(df[col])
            encoders[col] = le

    target_enc = LabelEncoder()
    df[target] = target_enc.fit_transform(df[target])

    X = df[features]
    y = df[target]
    return X, y, encoders, target_enc

def train_and_save_model(X, y, encoders, target_enc, path='fitlife_model'):
    os.makedirs(path, exist_ok=True)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    joblib.dump(model, f'{path}/model.pkl')
    joblib.dump(encoders, f'{path}/encoders.pkl')
    joblib.dump(target_enc, f'{path}/target_encoder.pkl')
    print(f'Model saved to: {path}')

# ===================
# 4. PREDICT USING MODEL
# ===================
def load_model(path='fitlife_model'):
    model = joblib.load(f'{path}/model.pkl')
    encoders = joblib.load(f'{path}/encoders.pkl')
    target_enc = joblib.load(f'{path}/target_encoder.pkl')
    return model, encoders, target_enc

def predict_emotion(activity_category, sub_category, intensity, mood_before, stress_level, path='fitlife_model'):
    model, encoders, target_enc = load_model(path)
    input_data = {
        'activity_category': encoders['activity_category'].transform([activity_category])[0],
        'sub-category': encoders['sub-category'].transform([sub_category])[0],
        'intensity': encoders['intensity'].transform([intensity])[0],
        'mood_before_(1-10)': mood_before,
        'stress_level_(1-10)': stress_level
    }
    df_input = pd.DataFrame([input_data])
    pred = model.predict(df_input)[0]
    return target_enc.inverse_transform([pred])[0]

# ===================
# MAIN FUNCTION TO RUN ALL
# ===================
if __name__ == '__main__':
    df = load_dataset('fitlife_emotional_dataset.csv')

    print('\n--- Top Mood Boosting Activities ---')
    print(top_mood_boosters(df))

    print('\n--- Top Stress Reducing Activities ---')
    print(top_stress_reducers(df))

    print('\n--- Recommendations by Mood and Stress (Rule-Based) ---')
    print(recommend_by_stats(df, mood_before=4, stress_level=8))

    print('\n--- Training ML Model for Emotion Prediction ---')
    X, y, encoders, target_enc = prepare_ml_data(df)
    train_and_save_model(X, y, encoders, target_enc)

    print('\n--- Predicting Emotion for Sample Activity ---')
    result = predict_emotion(
        activity_category='Physical - Exercise',
        sub_category='Mind-Body',
        intensity='High',
        mood_before=3,
        stress_level=9
    )
    print('Predicted Emotion:', result)
