package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type layoutField struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Offset  int64  `json:"offset"`
	Size    int64  `json:"size"`
	Align   int64  `json:"align"`
	Padding int64  `json:"padding"`
}

type layoutResult struct {
	Name            string        `json:"name"`
	File            string        `json:"file"`
	Line            int           `json:"line"`
	Size            int64         `json:"size"`
	OptimizedSize   int64         `json:"optimizedSize"`
	Fields          []layoutField `json:"fields"`
	OptimizedFields []layoutField `json:"optimizedFields"`
	SafeToApply     bool          `json:"safeToApply"`
	SafetyReasons   []string      `json:"safetyReasons"`
	OptimizedSource string        `json:"optimizedSource,omitempty"`
}

type listedPackage struct {
	Dir        string
	ImportPath string
	Name       string
	GoFiles    []string
	CgoFiles   []string
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "struct-layout" {
		fmt.Fprintln(os.Stderr, "usage: gotune-helper struct-layout -file <file.go> -name <StructName>")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("struct-layout", flag.ExitOnError)
	filename := flags.String("file", "", "Go source file")
	name := flags.String("name", "", "struct type name")
	_ = flags.Parse(os.Args[2:])
	if *filename == "" || *name == "" {
		fmt.Fprintln(os.Stderr, "-file and -name are required")
		os.Exit(2)
	}
	result, err := inspectStruct(*filename, *name)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func inspectStruct(filename, structName string) (layoutResult, error) {
	source, err := os.ReadFile(filename)
	if err != nil {
		return layoutResult{}, err
	}
	fset := token.NewFileSet()
	listed, err := listPackage(filepath.Dir(filename))
	if err != nil {
		return layoutResult{}, err
	}
	targetPackage := &ast.Package{Name: listed.Name, Files: make(map[string]*ast.File)}
	var targetFile *ast.File
	cleanFilename, _ := filepath.Abs(filename)
	activeFiles := append(append([]string(nil), listed.GoFiles...), listed.CgoFiles...)
	for _, name := range activeFiles {
		parsedName := filepath.Join(listed.Dir, name)
		parsedFile, parseErr := parser.ParseFile(fset, parsedName, nil, parser.ParseComments)
		if parseErr != nil {
			return layoutResult{}, parseErr
		}
		targetPackage.Files[parsedName] = parsedFile
		absolute, _ := filepath.Abs(parsedName)
		if absolute == cleanFilename {
			targetFile = parsedFile
		}
	}
	if targetFile == nil {
		return layoutResult{}, fmt.Errorf(
			"%s is excluded by the current GOOS, GOARCH, or build tags",
			filename,
		)
	}
	var typeSpec *ast.TypeSpec
	var structNode *ast.StructType
	for _, declaration := range targetFile.Decls {
		gen, ok := declaration.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			candidate, ok := spec.(*ast.TypeSpec)
			if !ok || candidate.Name.Name != structName {
				continue
			}
			value, ok := candidate.Type.(*ast.StructType)
			if !ok {
				return layoutResult{}, fmt.Errorf("%s is not a struct", structName)
			}
			typeSpec = candidate
			structNode = value
		}
	}
	if typeSpec == nil || structNode == nil {
		return layoutResult{}, fmt.Errorf("struct %s was not found in %s", structName, filename)
	}

	fileNames := make([]string, 0, len(targetPackage.Files))
	for parsedName := range targetPackage.Files {
		fileNames = append(fileNames, parsedName)
	}
	sort.Strings(fileNames)
	files := make([]*ast.File, 0, len(fileNames))
	for _, parsedName := range fileNames {
		files = append(files, targetPackage.Files[parsedName])
	}
	var typeErrors []string
	configuration := types.Config{
		Importer: moduleImporter(fset, filepath.Dir(filename)),
		Sizes:    types.SizesFor("gc", runtime.GOARCH),
		Error: func(err error) {
			typeErrors = append(typeErrors, err.Error())
		},
	}
	packagePath := listed.ImportPath
	if packagePath == "" {
		packagePath = targetPackage.Name
	}
	checked, checkErr := configuration.Check(packagePath, fset, files, nil)
	if checked == nil {
		return layoutResult{}, fmt.Errorf("could not type-check package: %v (%s)", checkErr, strings.Join(typeErrors, "; "))
	}
	object := checked.Scope().Lookup(structName)
	if object == nil {
		return layoutResult{}, fmt.Errorf("type information for %s was not found", structName)
	}
	named, ok := object.Type().(*types.Named)
	if !ok {
		return layoutResult{}, fmt.Errorf("%s is not a named type", structName)
	}
	structType, ok := named.Underlying().(*types.Struct)
	if !ok {
		return layoutResult{}, fmt.Errorf("%s is not a struct", structName)
	}
	for index := 0; index < structType.NumFields(); index++ {
		field := structType.Field(index)
		if strings.Contains(types.TypeString(field.Type(), nil), "invalid type") {
			return layoutResult{}, fmt.Errorf(
				"could not resolve the type of field %s; check the package build configuration",
				field.Name(),
			)
		}
	}
	sizes := configuration.Sizes
	currentOrder := make([]int, structType.NumFields())
	for index := range currentOrder {
		currentOrder[index] = index
	}
	optimizedOrder := append([]int(nil), currentOrder...)
	sort.SliceStable(optimizedOrder, func(left, right int) bool {
		leftField := structType.Field(optimizedOrder[left])
		rightField := structType.Field(optimizedOrder[right])
		leftSize := sizes.Sizeof(leftField.Type())
		rightSize := sizes.Sizeof(rightField.Type())
		if (leftSize == 0) != (rightSize == 0) {
			return leftSize == 0
		}
		leftAlign := sizes.Alignof(leftField.Type())
		rightAlign := sizes.Alignof(rightField.Type())
		if leftAlign != rightAlign {
			return leftAlign > rightAlign
		}
		return leftSize > rightSize
	})
	currentFields, currentSize := describeLayout(structType, currentOrder, sizes)
	optimizedFields, optimizedSize := describeLayout(structType, optimizedOrder, sizes)

	reasons := safetyReasons(targetPackage, targetFile, typeSpec, structNode, structName, source)
	result := layoutResult{
		Name:            structName,
		File:            filename,
		Line:            fset.Position(typeSpec.Pos()).Line,
		Size:            currentSize,
		OptimizedSize:   optimizedSize,
		Fields:          currentFields,
		OptimizedFields: optimizedFields,
		SafeToApply:     len(reasons) == 0,
		SafetyReasons:   reasons,
	}
	if result.SafeToApply && optimizedSize < currentSize {
		optimizedSource, rewriteErr := reorderStructSource(
			source,
			fset,
			structNode,
			optimizedOrder,
		)
		if rewriteErr != nil {
			result.SafeToApply = false
			result.SafetyReasons = append(result.SafetyReasons, rewriteErr.Error())
		} else {
			result.OptimizedSource = string(optimizedSource)
		}
	}
	return result, nil
}

func moduleImporter(fset *token.FileSet, directory string) types.Importer {
	exportFiles := make(map[string]string)
	goExecutable := goExecutablePath()
	return importer.ForCompiler(fset, "gc", func(importPath string) (io.ReadCloser, error) {
		exportFile := exportFiles[importPath]
		if exportFile == "" {
			command := exec.Command(goExecutable, "list", "-export", "-f={{.Export}}", importPath)
			command.Dir = directory
			output, err := command.CombinedOutput()
			if err != nil {
				return nil, fmt.Errorf(
					"resolve import %s: %w (%s)",
					importPath,
					err,
					strings.TrimSpace(string(output)),
				)
			}
			exportFile = strings.TrimSpace(string(output))
			if exportFile == "" {
				return nil, fmt.Errorf("resolve import %s: go list returned no export data", importPath)
			}
			exportFiles[importPath] = exportFile
		}
		return os.Open(exportFile)
	})
}

func listPackage(directory string) (listedPackage, error) {
	command := exec.Command(goExecutablePath(), "list", "-json", ".")
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		return listedPackage{}, fmt.Errorf(
			"resolve active package files: %w (%s)",
			err,
			strings.TrimSpace(string(output)),
		)
	}
	var listed listedPackage
	if err := json.Unmarshal(output, &listed); err != nil {
		return listedPackage{}, fmt.Errorf("decode go list output: %w", err)
	}
	if listed.Dir == "" || listed.Name == "" || len(listed.GoFiles)+len(listed.CgoFiles) == 0 {
		return listedPackage{}, fmt.Errorf("go list returned no active Go package files")
	}
	return listed, nil
}

func goExecutablePath() string {
	goExecutable := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goExecutable += ".exe"
	}
	return goExecutable
}

func describeLayout(value *types.Struct, order []int, sizes types.Sizes) ([]layoutField, int64) {
	fields := make([]*types.Var, len(order))
	tags := make([]string, len(order))
	for index, originalIndex := range order {
		fields[index] = value.Field(originalIndex)
		tags[index] = value.Tag(originalIndex)
	}
	reordered := types.NewStruct(fields, tags)
	offsets := sizes.Offsetsof(fields)
	total := sizes.Sizeof(reordered)
	result := make([]layoutField, len(fields))
	for index, field := range fields {
		next := total
		if index+1 < len(fields) {
			next = offsets[index+1]
		}
		size := sizes.Sizeof(field.Type())
		result[index] = layoutField{
			Name:    field.Name(),
			Type:    types.TypeString(field.Type(), func(pkg *types.Package) string { return pkg.Name() }),
			Offset:  offsets[index],
			Size:    size,
			Align:   sizes.Alignof(field.Type()),
			Padding: next - offsets[index] - size,
		}
	}
	return result, total
}

func safetyReasons(
	pkg *ast.Package,
	file *ast.File,
	spec *ast.TypeSpec,
	value *ast.StructType,
	structName string,
	source []byte,
) []string {
	var reasons []string
	if ast.IsExported(structName) {
		reasons = append(reasons, "the struct is exported and external positional literals or ABI assumptions cannot be ruled out")
	}
	for _, field := range value.Fields.List {
		if len(field.Names) == 0 {
			reasons = append(reasons, "the struct contains embedded fields")
		} else if len(field.Names) != 1 {
			reasons = append(reasons, "the struct contains a grouped field declaration")
		}
	}
	for _, parsedFile := range pkg.Files {
		ast.Inspect(parsedFile, func(node ast.Node) bool {
			switch candidate := node.(type) {
			case *ast.CompositeLit:
				identifier, ok := candidate.Type.(*ast.Ident)
				if !ok || identifier.Name != structName {
					return true
				}
				for _, element := range candidate.Elts {
					if _, keyed := element.(*ast.KeyValueExpr); !keyed {
						reasons = append(reasons, "the package contains an unkeyed struct literal")
						break
					}
				}
			case *ast.CallExpr:
				selector, ok := candidate.Fun.(*ast.SelectorExpr)
				if ok && selector.Sel.Name == "Offsetof" {
					reasons = append(reasons, "the package uses unsafe.Offsetof")
				}
			}
			return true
		})
		for _, imported := range parsedFile.Imports {
			pathValue := strings.Trim(imported.Path.Value, `"`)
			switch pathValue {
			case "C":
				reasons = append(reasons, "the package uses cgo")
			case "encoding/binary", "encoding/json", "encoding/xml":
				reasons = append(reasons, "the package imports "+pathValue+" and field order may affect external output")
			}
		}
	}
	if strings.Contains(string(source[:min(len(source), 2048)]), "Code generated") {
		reasons = append(reasons, "the source file is generated")
	}
	if f := fileForPosition(pkg, spec.Pos()); f != file {
		reasons = append(reasons, "the selected struct could not be tied to the active source file")
	}
	return uniqueStrings(reasons)
}

func reorderStructSource(
	source []byte,
	fset *token.FileSet,
	value *ast.StructType,
	order []int,
) ([]byte, error) {
	if len(value.Fields.List) != len(order) {
		return nil, fmt.Errorf("field declarations do not map one-to-one to layout fields")
	}
	bodyStart := fset.Position(value.Fields.Opening).Offset + 1
	bodyEnd := fset.Position(value.Fields.Closing).Offset
	starts := make([]int, len(value.Fields.List))
	for index, field := range value.Fields.List {
		position := field.Pos()
		if field.Doc != nil {
			position = field.Doc.Pos()
		}
		starts[index] = lineStart(source, fset.Position(position).Offset)
		if starts[index] < bodyStart {
			return nil, fmt.Errorf("single-line structs are preview-only")
		}
	}
	closingLine := lineStart(source, bodyEnd)
	if closingLine < starts[len(starts)-1] {
		return nil, fmt.Errorf("single-line structs are preview-only")
	}
	segments := make([][]byte, len(starts))
	for index, start := range starts {
		end := closingLine
		if index+1 < len(starts) {
			end = starts[index+1]
		}
		segments[index] = append([]byte(nil), source[start:end]...)
	}
	optimizedBody := append([]byte(nil), source[bodyStart:starts[0]]...)
	for _, originalIndex := range order {
		optimizedBody = append(optimizedBody, segments[originalIndex]...)
	}
	optimizedBody = append(optimizedBody, source[closingLine:bodyEnd]...)
	result := append([]byte(nil), source[:bodyStart]...)
	result = append(result, optimizedBody...)
	result = append(result, source[bodyEnd:]...)
	return result, nil
}

func lineStart(source []byte, offset int) int {
	for offset > 0 && source[offset-1] != '\n' {
		offset--
	}
	return offset
}

func fileForPosition(pkg *ast.Package, position token.Pos) *ast.File {
	for _, file := range pkg.Files {
		if file.Pos() <= position && position <= file.End() {
			return file
		}
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var result []string
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
