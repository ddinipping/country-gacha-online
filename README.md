# 국가 뽑기 온라인 서버

이 폴더는 기존 `country_gacha_1.html`을 온라인 게임처럼 실행하기 위한 첫 서버 버전입니다.

## 실행

Node.js가 설치되어 있으면:

```powershell
cd online-game
npm start
```

브라우저에서 열기:

```text
http://localhost:8787
```

같은 와이파이의 휴대폰에서 접속하려면 PC의 내부 IP를 확인한 뒤:

```text
http://PC-IP주소:8787
```

예: `http://192.168.0.12:8787`

## 모든 와이파이에서 접속하게 만들기

친구가 다른 와이파이나 모바일 데이터에서도 들어오게 하려면 이 서버를 인터넷에 배포해야 합니다.

### Render 배포

1. 이 `online-game` 폴더를 GitHub 저장소에 올립니다.
2. Render에서 새 Web Service를 만듭니다.
3. 저장소를 연결합니다.
4. `render.yaml`을 사용하는 Blueprint 또는 Docker Web Service로 배포합니다.
5. 배포 후 생기는 `https://...onrender.com` 주소를 친구에게 공유합니다.

### Fly.io 배포

1. Fly CLI를 설치하고 로그인합니다.
2. `online-game` 폴더에서 실행합니다.

```powershell
fly launch
fly deploy
```

3. 배포 후 생기는 `https://앱이름.fly.dev` 주소를 친구에게 공유합니다.

### Docker로 다른 서버에 올리기

```powershell
docker build -t country-gacha-online .
docker run -p 8787:8787 country-gacha-online
```

서버/VPS의 공인 주소로 접속하면 됩니다.

## 들어간 기능

- 이메일/비밀번호 가입
- 로그인 토큰 저장
- 서버 저장 올리기/불러오기
- 서버 방 코드 생성/입장
- 방 상태 자동 갱신
- 기존 수동 배틀 코드 유지

## 데이터

서버 데이터는 `data/db.json`에 저장됩니다.

배포 환경에서는 서버가 재시작될 때 데이터가 사라질 수 있습니다. 오래 운영하려면 `DATA_DIR`을 영구 디스크에 연결하거나, 나중에 PostgreSQL 같은 데이터베이스로 바꾸는 것이 좋습니다.

## 주의

이 서버는 개발용 첫 버전입니다. 실제 Play Store 앱으로 배포하려면 HTTPS, 더 안전한 비밀번호 해시, 서버 배포, 개인정보 처리방침, 앱 서명, AAB 빌드가 추가로 필요합니다.
