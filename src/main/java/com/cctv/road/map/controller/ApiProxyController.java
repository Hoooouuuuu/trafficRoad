package com.cctv.road.map.controller;

import java.io.StringReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.ExchangeStrategies;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ResponseStatusException;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import com.cctv.road.map.dto.BusArrivalDto;
import com.cctv.road.map.dto.BusRouteDto;
import com.cctv.road.map.dto.UnifiedBusStopDto;
import com.cctv.road.map.repository.BusStopRepository;

import io.github.cdimascio.dotenv.Dotenv;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/proxy")
public class ApiProxyController {

  private final BusStopRepository busStopRepository;

  private final WebClient naverClient;
  private final WebClient seoulBusClient;
  private final WebClient kakaoClient;
  private final WebClient seoulOpenApiClient;
  private final WebClient itsClient;
  private final WebClient defaultClient;

  private final Dotenv dotenv = Dotenv.configure().directory("./").load();

  @Autowired
  public ApiProxyController(WebClient.Builder builder, BusStopRepository busStopRepository) {
    this.busStopRepository = busStopRepository;

    // System.out.println("🔑 .env 로드 완료, SEOUL_BUS_API_KEY: " +
    // (dotenv.get("SEOUL_BUS_API_KEY") != null ? "설정됨" : "없음"));

    this.naverClient = builder
        .baseUrl("https://naveropenapi.apigw.ntruss.com")
        .defaultHeader("X-NCP-APIGW-API-KEY-ID", dotenv.get("NAVER_MAP_CLIENT_ID"))
        .defaultHeader("X-NCP-APIGW-API-KEY", dotenv.get("NAVER_MAP_CLIENT_SECRET"))
        .build();

    this.seoulBusClient = builder.baseUrl("http://ws.bus.go.kr").build();

    this.kakaoClient = builder
        .baseUrl("https://dapi.kakao.com")
        .defaultHeader("Authorization", "KakaoAK " + dotenv.get("KAKAO_REST_API_KEY"))
        .build();

    this.seoulOpenApiClient = builder
        .baseUrl("http://openapi.seoul.go.kr:8088")
        .build();

    this.itsClient = builder
        .baseUrl("https://openapi.its.go.kr:9443")
        .exchangeStrategies(ExchangeStrategies.builder()
            .codecs(config -> config.defaultCodecs().maxInMemorySize(3 * 1024 * 1024))
            .build())
        .build();

    this.defaultClient = builder.build();
  }

  @GetMapping("/naver-direction")
  public Mono<String> getNaverDirectionRoute(
      @RequestParam double startLat,
      @RequestParam double startLng,
      @RequestParam double goalLat,
      @RequestParam double goalLng) {
    return naverClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/map-direction/v1/driving")
            .queryParam("start", startLng + "," + startLat)
            .queryParam("goal", goalLng + "," + goalLat)
            .queryParam("option", "trafast")
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("네이버 경로 탐색 API 호출 실패", e));
  }

  @GetMapping("/naver-geocode")
  public Mono<String> geocode(@RequestParam String query) {
    return naverClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/map-geocode/v2/geocode")
            .queryParam("query", query)
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("네이버 지오코딩 API 호출 실패", e));
  }

  @GetMapping("/naver-place")
  public Mono<String> searchPlace(@RequestParam String query) {
    return naverClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/map-place/v1/search")
            .queryParam("query", query)
            .queryParam("coordinate", "127.1054328,37.3595953")
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("네이버 장소 검색 API 호출 실패", e));
  }

  @GetMapping("/kakao-place")
  public Mono<String> searchKakaoPlace(@RequestParam String query) {
    return kakaoClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/v2/local/search/keyword.json")
            .queryParam("query", query)
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("카카오 장소 검색 API 호출 실패", e));
  }

  @GetMapping("/busPosByNumber")
  public String getBusPositionsByNumber(@RequestParam String routeNumber) {
    // 1) DB에서 routeId 꺼내기
    String routeId = busStopRepository.findRouteIdByRouteNumber(routeNumber);
    if (routeId == null) {
      throw new ResponseStatusException(
          HttpStatus.NOT_FOUND, "해당 버스 번호(routeNumber)로 저장된 routeId가 없습니다: " + routeNumber);
    }
    // 2) 기존 로직 재사용
    return fetchBusPositionsFromSeoulApi(routeId);
  }

  @GetMapping("/busPos")
  public String getBusPositions(@RequestParam String routeId) {
    return fetchBusPositionsFromSeoulApi(routeId);
  }

  private String fetchBusPositionsFromSeoulApi(String routeId) {
    String key = dotenv.get("SEOUL_BUS_API_KEY");
    if (key == null || key.trim().isEmpty()) {
      throw new RuntimeException("API 키 누락");
    }
    key = key.trim();

    String url = "http://ws.bus.go.kr/api/rest/buspos/getBusPosByRtid"
        + "?serviceKey=" + key
        + "&busRouteId=" + routeId
        + "&resultType=json";

    try {
      HttpResponse<String> resp = HttpClient.newHttpClient()
          .send(
              HttpRequest.newBuilder()
                  .uri(URI.create(url))
                  .header("Accept", "application/json")
                  .header("User-Agent", "Java-HttpClient")
                  .GET()
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      if (resp.statusCode() != 200) {
        throw new RuntimeException("서울시 API 오류: " + resp.statusCode());
      }
      return resp.body();
    } catch (Exception e) {
      throw new RuntimeException("버스 위치 API 호출 실패: " + e.getMessage(), e);
    }
  }

  @GetMapping("/bus/routes")
  public ResponseEntity<?> getRoutesOrStops(
      @RequestParam(required = false) String stopId,
      @RequestParam(required = false) String routeNumber) {

    // 1. 정류장 ID로 경유 노선 조회 (도착 정보 창에서 사용)
    if (stopId != null) {
      List<BusRouteDto> routes = busStopRepository.findRoutesByStopId(stopId)
          .stream()
          .map(view -> new BusRouteDto(view.getRouteId(), view.getRouteName()))
          .toList();

      return ResponseEntity.ok(routes);
    }

    // 2. 노선 번호로 정류장 목록 조회 (노선 상세 패널에서 사용)
    if (routeNumber != null) {
      List<UnifiedBusStopDto> stops = busStopRepository.findByRouteNameOrderByStationOrderAsc(routeNumber)
          .stream()
          .map(stop -> new UnifiedBusStopDto(
              stop.getNodeId(),
              stop.getStationName(),
              stop.getArsId(),
              stop.getLatitude(),
              stop.getLongitude(),
              stop.getRouteId(),
              stop.getRouteName(),
              stop.getStationOrder()))
          .toList();

      return ResponseEntity.ok(stops);
    }

    return ResponseEntity.badRequest().body("stopId 또는 routeNumber 중 하나는 필수입니다.");
  }

  @GetMapping("/bus/stops")
  public ResponseEntity<List<UnifiedBusStopDto>> getBusStopsByRegion(@RequestParam String region) {
    if (!"서울특별시".equals(region)) {
      return ResponseEntity.ok(List.of());
    }

    List<UnifiedBusStopDto> stops = busStopRepository.findAll().stream()
        .limit(1000)
        .map(stop -> new UnifiedBusStopDto(
            stop.getNodeId(),
            stop.getStationName(),
            stop.getArsId(),
            stop.getLatitude(),
            stop.getLongitude(),
            null, // 노선 ID 없음
            null, // 노선 번호 없음
            null // 정류소 순서 없음
        ))
        .collect(Collectors.toList());

    return ResponseEntity.ok(stops);
  }

  @GetMapping("/bus/regions")
  public ResponseEntity<List<String>> getAvailableBusRegions() {
    List<String> regions = List.of(
        "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시",
        "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도", "전라북도",
        "전라남도", "경상북도", "경상남도", "제주특별자치도");
    return ResponseEntity.ok(regions);
  }

  @GetMapping("/bus/arrivals")
  public ResponseEntity<List<BusArrivalDto>> getArrivals(
      @RequestParam String stopId,
      @RequestParam String arsId) {

    String encodedKey = dotenv.get("SEOUL_BUS_API_KEY").trim();

    String url = String.format(
        "http://ws.bus.go.kr/api/rest/arrive/getLowArrInfoByStId?serviceKey=%s&stId=%s&arsId=%s",
        encodedKey, stopId, arsId);

    try {
      HttpResponse<String> resp = HttpClient.newHttpClient()
          .send(HttpRequest.newBuilder()
              .uri(URI.create(url))
              .header("Accept", "application/xml")
              .GET()
              .build(),
              HttpResponse.BodyHandlers.ofString());

      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      DocumentBuilder builder = factory.newDocumentBuilder();
      Document doc = builder.parse(new InputSource(new StringReader(resp.body())));

      NodeList itemList = doc.getElementsByTagName("itemList");
      List<BusArrivalDto> results = new ArrayList<>();

      for (int i = 0; i < itemList.getLength(); i++) {
        Element item = (Element) itemList.item(i);

        String routeNumber = getTagValue("rtNm", item);
        String arrivalMsg = getTagValue("arrmsg1", item);
        String congestionCode = getTagValue("reride_Num1", item);
        String routeTypeCode = getTagValue("routeType", item);
        String plainNo = getTagValue("plainNo1", item); // 차량번호

        // 혼잡도 → 텍스트 변환
        String congestion = switch (congestionCode) {
          case "3" -> "여유";
          case "4" -> "보통";
          case "5" -> "혼잡";
          default -> "정보 없음";
        };

        // 버스 타입 코드 → 명칭 변환
        String routeType = switch (routeTypeCode) {
          case "1" -> "공항";
          case "2" -> "마을";
          case "3" -> "간선";
          case "4" -> "지선";
          case "5" -> "순환";
          case "6" -> "광역";
          case "7" -> "인천";
          case "8" -> "경기";
          case "9" -> "폐지";
          case "10" -> "공용";
          case "11" -> "청주";
          case "12" -> "세종";
          case "13" -> "기타";
          default -> "기타";
        };

        // 🔎 운행 상태 판단
        String status = arrivalMsg;

        if ("회차지".equalsIgnoreCase(arrivalMsg) || arrivalMsg.contains("회차지")) {
          status = "회차 대기";
        } else if ((arrivalMsg == null || arrivalMsg.isBlank()) &&
            (congestionCode == null || congestionCode.isBlank()) &&
            (plainNo == null || plainNo.isBlank())) {
          status = "운행 대기";
        }

        // 🕒 운행시간 검사
        boolean isOperational = true;
        String routeId = busStopRepository.findRouteIdByRouteNumber(routeNumber);
        if (routeId != null) {
          Map<String, String> timeInfo = fetchRouteTimes(routeId);
          if (timeInfo != null) {
            String first = timeInfo.get("firstTime");
            String last = timeInfo.get("lastTime");
            if (!isNowInServiceTime(first, last)) {
              status = "운행 종료";
              congestion = "운행 종료";
              isOperational = false;
            }
          }
        }

        // 상태 덮어쓰기
        BusArrivalDto dto = new BusArrivalDto(
            routeNumber,
            status,
            congestion,
            stopId,
            arsId,
            routeType);
        results.add(dto);
      }

      return ResponseEntity.ok(results);

    } catch (Exception e) {
      System.err.println("❌ 버스 도착 정보 호출 실패: " + e.getMessage());
      return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
          .body(List.of(new BusArrivalDto("오류", "도착 정보 파싱 실패", "정보 없음")));
    }
  }

  private Map<String, String> fetchRouteTimes(String routeId) {
    try {
      String key = dotenv.get("SEOUL_BUS_API_KEY").trim();
      String url = String.format(
          "http://ws.bus.go.kr/api/rest/busRouteInfo/getRouteInfo?serviceKey=%s&busRouteId=%s",
          key, routeId);

      HttpResponse<String> resp = HttpClient.newHttpClient()
          .send(HttpRequest.newBuilder()
              .uri(URI.create(url))
              .header("Accept", "application/xml")
              .GET()
              .build(),
              HttpResponse.BodyHandlers.ofString());

      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      DocumentBuilder builder = factory.newDocumentBuilder();
      Document doc = builder.parse(new InputSource(new StringReader(resp.body())));

      NodeList nodeList = doc.getElementsByTagName("itemList");
      if (nodeList.getLength() == 0)
        return null;

      Element item = (Element) nodeList.item(0);
      String firstRaw = getTagValue("firstBusTm", item);
      String lastRaw = getTagValue("lastBusTm", item);

      String firstTime = formatTime(firstRaw);
      String lastTime = formatTime(lastRaw);

      return Map.of("firstTime", firstTime, "lastTime", lastTime);

    } catch (Exception e) {
      System.err.println("❌ 운행시간 조회 실패: " + e.getMessage());
      return null;
    }
  }

  private boolean isNowInServiceTime(String first, String last) {
    try {
      LocalTime now = LocalTime.now();
      LocalTime start = LocalTime.parse(first);
      LocalTime end = LocalTime.parse(last);

      if (end.isBefore(start)) {
        // 자정을 넘긴 경우 (예: 23:30 ~ 04:00)
        return now.isAfter(start) || now.isBefore(end);
      } else {
        return !now.isBefore(start) && !now.isAfter(end);
      }
    } catch (Exception e) {
      return true;
    }
  }

  // XML 태그 값 추출 유틸
  private String getTagValue(String tag, Element element) {
    NodeList list = element.getElementsByTagName(tag);
    if (list.getLength() > 0 && list.item(0).getFirstChild() != null) {
      return list.item(0).getFirstChild().getNodeValue();
    }
    return "";
  }

  @GetMapping("/bus/routes/by-stop")
  public ResponseEntity<List<BusRouteDto>> getRoutesByStop(@RequestParam String stopId) {
    List<Object[]> raw = busStopRepository.findRoutesByNodeId(stopId);

    List<BusRouteDto> routes = raw.stream()
        .map(row -> new BusRouteDto((String) row[0], (String) row[1]))
        .toList();

    return ResponseEntity.ok(routes);
  }

  @GetMapping("/bus/detail")
  public ResponseEntity<Map<String, String>> getRouteDetail(
      @RequestParam(required = false) String routeId,
      @RequestParam(required = false) String routeNumber) {

    try {
      // ✅ routeNumber만 있는 경우 → DB로 routeId 조회
      if (routeId == null && routeNumber != null) {
        routeId = busStopRepository.findRouteIdByRouteNumber(routeNumber);
        if (routeId == null) {
          return ResponseEntity.status(HttpStatus.NOT_FOUND)
              .body(Map.of("error", "해당 노선 없음"));
        }
      }

      // ✅ 둘 다 없는 경우 → 잘못된 요청
      if (routeId == null) {
        return ResponseEntity.badRequest()
            .body(Map.of("error", "routeId 또는 routeNumber는 필수입니다"));
      }

      String encodedKey = dotenv.get("SEOUL_BUS_API_KEY").trim();

      String url = String.format(
          "http://ws.bus.go.kr/api/rest/busRouteInfo/getRouteInfo?serviceKey=%s&busRouteId=%s",
          encodedKey, routeId);

      HttpResponse<String> resp = HttpClient.newHttpClient()
          .send(HttpRequest.newBuilder()
              .uri(URI.create(url))
              .header("Accept", "application/xml")
              .GET()
              .build(),
              HttpResponse.BodyHandlers.ofString());

      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      DocumentBuilder builder = factory.newDocumentBuilder();
      Document doc = builder.parse(new InputSource(new StringReader(resp.body())));

      NodeList nodeList = doc.getElementsByTagName("itemList");
      if (nodeList.getLength() == 0) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(Map.of("error", "노선 정보 없음"));
      }

      Element item = (Element) nodeList.item(0);

      String routeNm = getTagValue("busRouteNm", item);
      String firstRaw = getTagValue("firstBusTm", item); // 예: 20230510043000
      String lastRaw = getTagValue("lastBusTm", item);
      String interval = getTagValue("term", item); // 배차 간격 (분)

      String firstTime = formatTime(firstRaw);
      String lastTime = formatTime(lastRaw);

      Map<String, String> result = new HashMap<>();
      result.put("routeNumber", routeNm);
      result.put("interval", interval.isBlank() ? "정보 없음" : interval + "분");
      result.put("firstTime", firstTime);
      result.put("lastTime", lastTime);

      return ResponseEntity.ok(result);

    } catch (Exception e) {
      System.err.println("❌ 버스 상세정보 조회 실패: " + e.getMessage());
      return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
          .body(Map.of("error", "API 요청 실패"));
    }
  }

  // 🕒 yyyyMMddHHmmss → HH:mm 형식 변환
  private String formatTime(String raw) {
    if (raw == null || raw.length() < 12)
      return "정보 없음";
    try {
      String hour = raw.substring(8, 10);
      String min = raw.substring(10, 12);
      return hour + ":" + min;
    } catch (Exception e) {
      return "정보 없음";
    }
  }

  @GetMapping("/road-event-all")
  public Mono<String> getAllRoadEvents() {
    return itsClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/eventInfo")
            .queryParam("apiKey", dotenv.get("ITS_API_KEY"))
            .queryParam("type", "all")
            .queryParam(
                "eventType", "all")
            .queryParam("getType", "json")
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("전체 도로 이벤트 API 호출 실패", e));
  }

  @GetMapping("/road-event")
  public Mono<String> getRoadEventInBounds(
      @RequestParam double minX,
      @RequestParam double minY,
      @RequestParam double maxX,
      @RequestParam double maxY) {
    return itsClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/eventInfo")
            .queryParam("apiKey", dotenv.get("ITS_API_KEY"))
            .queryParam("type", "all")
            .queryParam("eventType", "all")
            .queryParam("getType", "json")
            .queryParam("minX", minX)
            .queryParam("maxX", maxX)
            .queryParam("minY", minY)
            .queryParam("maxY", maxY)
            .build())
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("도로 이벤트 API 호출 실패", e));
  }

  @GetMapping("/subway/arrival")
  public Mono<String> getSubwayArrival() {
    return defaultClient.get()
        .uri("http://swopenapi.seoul.go.kr/api/subway/{key}/xml/realtimeStationArrival/0/1000/",
            dotenv.get("SEOUL_SUBWAY_API_KEY"))
        .retrieve()
        .onStatus(status -> !status.is2xxSuccessful(),
            response -> response.bodyToMono(String.class).flatMap(body -> {
              System.err.println("❌ [지하철] 오류 상태코드: " + response.statusCode());
              System.err.println("❌ [지하철] 오류 응답:\n" + body);
              return Mono.error(new RuntimeException(
                  "지하철 도착 정보 API 실패: " + body));
            }))
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("지하철 도착 정보 API 호출 실패", e));
  }

  @GetMapping("/bike-list")
  public Mono<String> getBikeList() {
    return seoulOpenApiClient.get()
        .uri(uriBuilder -> uriBuilder
            .path("/{apiKey}/json/bikeList/1/1000/")
            .build(dotenv.get("SEOUL_BIKE_API_KEY")))
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("서울 따릉이 정보 API 호출 실패", e));
  }

  @GetMapping("/parking/seoul-city")
  public Mono<String> getSeoulCityParkingData() {
    return seoulOpenApiClient.get()
        .uri("/{apiKey}/json/GetParkingInfo/1/1000/",
            dotenv.get("SEOUL_CITY_PARKING_API_KEY"))
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .onStatus(status -> !status.is2xxSuccessful(),
            response -> response.bodyToMono(String.class).flatMap(body -> {
              System.err.println("❌ [주차장] 오류 상태코드: " + response.statusCode());
              System.err.println("❌ [주차장] 오류 응답:\n" + body);
              return Mono.error(
                  new RuntimeException("주차장 정보 API 실패: " + body));
            }))
        .bodyToMono(String.class)
        .onErrorMap(e -> new RuntimeException("서울 주차장 정보 API 호출 실패", e));
  }

  /*
   * // 도로 중심선 버스 경로 찍기 봉 인 !!
   * 
   * @GetMapping("/naver-driving-path")
   * public ResponseEntity<?> getSmoothedPath(
   * 
   * @RequestParam double startLat,
   * 
   * @RequestParam double startLng,
   * 
   * @RequestParam double goalLat,
   * 
   * @RequestParam double goalLng) {
   * 
   * try {
   * String response = naverClient.get()
   * .uri(uriBuilder -> uriBuilder
   * .path("/map-direction/v1/driving")
   * .queryParam("start", startLng + "," + startLat)
   * .queryParam("goal", goalLng + "," + goalLat)
   * .queryParam("option", "trafast")
   * .build())
   * .retrieve()
   * .bodyToMono(String.class)
   * .block(); // Mono -> String 동기 처리
   * 
   * ObjectMapper mapper = new ObjectMapper();
   * JsonNode root = mapper.readTree(response);
   * JsonNode pathArray = root.at("/route/trafast/0/path");
   * 
   * List<Map<String, Double>> coordinates = new ArrayList<>();
   * for (JsonNode coord : pathArray) {
   * double lng = coord.get(0).asDouble();
   * double lat = coord.get(1).asDouble();
   * Map<String, Double> point = new HashMap<>();
   * point.put("lat", lat);
   * point.put("lng", lng);
   * coordinates.add(point);
   * }
   * 
   * return ResponseEntity.ok(coordinates);
   * 
   * } catch (Exception e) {
   * e.printStackTrace();
   * return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
   * .body(Map.of("error", "경로 처리 실패: " + e.getMessage()));
   * }
   * }
   */
}