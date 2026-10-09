# iframe 탐색 처리 계획

- [x] 기존 클릭 가능한 요소에 가시 iframe을 탐색 후보로 추가하고, 선택된 iframe은 primary와 다른 색상으로 표시한다.
- [x] iframe 선택을 기억하고, spotlight 해제(L스틱 중립 또는 B) 후 재시작하면 해당 iframe 내부에서 spotlight를 연다.
- [x] 프레임별 스크립트와 메시지로 현재 탐색 프레임·부모 관계를 관리하고, 게임패드 입력이 중복 처리되지 않게 한다.
- [x] iframe 내부에서 Y를 누르면 부모로 복귀한다. spotlight 오버라이드가 없는 상태의 ESC/B도 부모로 복귀하고, spotlight 표시 중 B는 오버레이 해제를 유지한다.
- [ ] Chrome에서 동일 출처·다른 출처·중첩 iframe 진입과 부모 복귀, 후보 표시, 입력 전달을 확인한다. (라우팅 자동 테스트 통과, Chrome 실기 확인 대기)
- [x] 구현에 맞춰 [요구사항](wiki/REQUIREMENT.md)·[용어](wiki/TERMS.md) 위키와 [사용법](README.md)을 갱신한다.
- [x] 구현 완료 시 [package.json](package.json)과 [manifest.json](public/manifest.json)의 버전을 함께 올리고, 빌드 확인 후 `npm run package`로 버전 ZIP과 [최신 ZIP](release/joy-of-nav-latest.zip)을 갱신한다.
