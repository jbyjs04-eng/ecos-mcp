# ECOS MCP (한국은행 경제통계)

Claude 커스텀 커넥터로 한국은행 ECOS 통계를 조회하는 MCP 서버입니다. Vercel에 그대로 배포되며 외부 라이브러리가 없습니다.

## 연결 주소

```
https://<프로젝트>.vercel.app/api/mcp?ecos_key=<ECOS 인증키>
```

인증키는 ecos.bok.or.kr → 개발/활용 → OpenAPI → 인증키 신청에서 무료로 발급받습니다.
주소에 키를 넣지 않으려면 Vercel 프로젝트의 Settings → Environment Variables에 `ECOS_API_KEY`를 등록해도 됩니다.

## 도구

| 도구 | 용도 |
|---|---|
| `get_indicator` | 기준금리·국고채(1~30년)·회사채 AA-/BBB-·CD·콜금리·환율(USD/EUR/JPY100/CNY)·CPI 기간 조회 |
| `rates_as_of` | 평가기준일 현재 지표 일괄 조회(휴일은 직전 영업일) |
| `search_statistics` | 통계표코드·항목코드 직접 조회 |
| `search_tables` | 통계표 이름으로 코드 찾기 |
| `list_items` | 통계표 항목코드·주기·단위 확인 |
| `key_statistics` | 100대 통계지표 최신값 |
| `search_word` | 통계용어사전 |

출처: 한국은행 경제통계시스템(ECOS). 실무 참고용입니다.
