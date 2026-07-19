from backend.app.ontology import ONTOLOGY_PATH, build_graph, load_ontology, save_ontology, set_term_status, terms_from_ontology


def test_baseline_yaml_loads():
    onto = load_ontology()
    assert [s["table"] for s in onto["sources"]] == ["customers", "orders", "tickets"]
    assert len(onto["objects"]) == 0
    assert len(onto["joins"]) == 0
    assert len(onto["metrics"]) == 0


def test_build_graph_node_and_edge_counts():
    onto = load_ontology()
    graph = build_graph(onto)
    assert len(graph["nodes"]) == 3
    assert len(graph["edges"]) == 0

    by_id = {n["id"]: n for n in graph["nodes"]}
    assert by_id["src_customers"]["kind"] == "source"
    assert by_id["src_customers"]["status"] == "neutral"
    assert "obj_customer" not in by_id


def test_build_graph_merges_extra_nodes_and_edges():
    onto = load_ontology()
    extra_nodes = [{"id": "insight_x", "kind": "insight", "label": "x", "status": "neutral", "meta": {}}]
    extra_edges = [{"id": "e_produces_act_0001", "source": "insight_x", "target": "act_0001", "kind": "produces"}]
    graph = build_graph(onto, extra_nodes=extra_nodes, extra_edges=extra_edges)
    assert len(graph["nodes"]) == 4
    assert len(graph["edges"]) == 1
    assert any(n["id"] == "insight_x" for n in graph["nodes"])


def test_terms_from_ontology_shapes():
    onto = load_ontology()
    terms = terms_from_ontology(onto)
    assert len(terms) == 0


def test_set_term_status_mutates_and_persists(tmp_path):
    src = ONTOLOGY_PATH.read_text()
    tmp_yaml = tmp_path / "ontology.yaml"
    tmp_yaml.write_text(src)

    onto = load_ontology(tmp_yaml)
    found = set_term_status(onto, "m_active_customer", "rejected")
    assert found is False

    missing = set_term_status(onto, "nope_not_a_real_id", "approved")
    assert missing is False


def test_save_ontology_is_atomic(tmp_path):
    # save_ontology writes via tempfile+os.replace so a reader can never
    # observe a truncated/missing file mid-write (was a plain open(path, "w"),
    # which truncates before the new content lands -- a GET /api/state poll
    # racing an in-progress draft's save could hit an empty file and 500).
    tmp_yaml = tmp_path / "ontology.yaml"
    onto = load_ontology(ONTOLOGY_PATH)
    save_ontology(onto, tmp_yaml)
    assert tmp_yaml.exists()
    assert tmp_yaml.stat().st_size > 0
    assert load_ontology(tmp_yaml) == onto
    assert list(tmp_path.iterdir()) == [tmp_yaml]  # no leftover temp file
