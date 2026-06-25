# Render 배포하기

이 문서는 국가 뽑기 온라인 서버를 Render에 올려서 다른 와이파이/모바일 데이터에서도 접속하게 만드는 순서입니다.

## 1. GitHub에 올리기

Render는 보통 GitHub 저장소를 연결해서 배포합니다.

올릴 폴더:

```text
online-game
```

저장소 루트에 `online-game` 폴더를 그대로 올리거나, `online-game` 안의 파일들을 새 저장소 루트로 올려도 됩니다.

## 2. Render에서 Web Service 만들기

1. Render에 로그인합니다.
2. New → Web Service를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. Root Directory가 필요하면 `online-game`으로 설정합니다.
5. Docker 배포를 선택합니다.
6. Health Check Path는 `/api/health`로 둡니다.
7. 배포합니다.

## 3. 접속 주소

배포가 끝나면 Render가 이런 주소를 줍니다.

```text
https://country-gacha-online.onrender.com
```

이 주소를 친구에게 보내면 다른 와이파이나 모바일 데이터에서도 접속할 수 있습니다.

## 4. 저장 데이터 주의

현재 서버는 `data/db.json`에 계정/저장/방 정보를 저장합니다.

Render 무료 플랜에서는 서버 파일이 재시작 때 사라질 수 있습니다. 진짜 오래 운영하려면 둘 중 하나가 필요합니다.

- Render Persistent Disk 추가
- PostgreSQL 같은 외부 데이터베이스로 변경

## 5. 지금 서버가 제공하는 기능

- 회원가입
- 로그인
- 저장 데이터 서버 업로드
- 저장 데이터 서버 다운로드
- 방 코드 생성/입장
- 방 상태 자동 갱신

## 6. 다음 업그레이드 후보

- PostgreSQL 저장소
- Socket.IO 실시간 대전
- 비밀번호 bcrypt 해시
- 관리자 페이지
- Android 앱 포장
