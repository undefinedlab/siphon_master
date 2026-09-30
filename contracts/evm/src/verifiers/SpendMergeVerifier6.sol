// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 merge6 zkey sha256=0c051fcf18bb881a6a6e1cd7cec12196bd44d5f7c162876be15277b8672f38d2
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendMergeVerifier6 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 34702538010584130036541468169725998621115499847649695656191683585580671358;
    uint256 constant IC0y = 11049797930727948972080196414176004677590938189115293647477013298259119024890;

    uint256 constant IC1x = 1620946661942771101276991425291834581792445361106698806549610933581109756896;
    uint256 constant IC1y = 1962166547142072031487671621600794228386387189332115889322962547926945380234;

    uint256 constant IC2x = 20630128648702629798288805240948774764986402406382413230045882457861658626310;
    uint256 constant IC2y = 13940840679849219277974715236190702972647840911933079813246093097513104490199;

    uint256 constant IC3x = 16456546894689641011331811703260898474497012414792234569188495112041162192456;
    uint256 constant IC3y = 13687400408942663094846109918591811455955119680856676193378489572671748359740;

    uint256 constant IC4x = 13400625253950757805451358467398078365302352183309721412137338653077055457114;
    uint256 constant IC4y = 3659275524704398131482764936800738138791301357912504515196393552510925832709;

    uint256 constant IC5x = 3285238218740789464606157527283200252826525754702193489681025996619692612275;
    uint256 constant IC5y = 21586482674696415726876856161326457556599402123353950644901067963573764962442;

    uint256 constant IC6x = 5213264460022817871224367565472669904307255508913385467656852363978222481392;
    uint256 constant IC6y = 14789237159942351926410531700762090528397071945529847893981807997439858151441;

    uint256 constant IC7x = 6757442100460446962587916479125242364169513412399792640511891237245820448684;
    uint256 constant IC7y = 13892184323071710507698049493497373478112506242039648657703047982237798486569;

    uint256 constant IC8x = 7027243263126694544346312488371179819257607171864740704963575041631008960259;
    uint256 constant IC8y = 2884786073485736060281678456702473999599426026957311284088778072350512488777;

    uint256 constant IC9x = 11309822618438987667879262722342890630772036817419401756561061992229343546103;
    uint256 constant IC9y = 1163124975224365683729331319073152346005986601550766245115786428097073578141;

    uint256 constant IC10x = 632634167098441789446589539946173875579218795733437067327060310366842801611;
    uint256 constant IC10y = 666339497912537909240881754703667143615562420619616263775502179701476540297;

    uint256 constant IC11x = 10891336395656648352172966515778989570890814128976170475441720793748430748861;
    uint256 constant IC11y = 3073888410581038886169561960578792164233881197840791478628160046331557038146;

    uint256 constant IC12x = 2983824262952778274799533128914476498820013673045261939793315974208006497972;
    uint256 constant IC12y = 8384649466168429094935154145221894415816340147163142060001171520183063282265;

    uint256 constant IC13x = 3395963477800654979183810996637842118468250354439140581299509714200159867686;
    uint256 constant IC13y = 8934323137139754512090015320021573913712853941663658141200329804731123972372;

    uint256 constant IC14x = 6882910284688318386787086474698444627713961034552999214152141958729594506574;
    uint256 constant IC14y = 3451425312222529822278353192683637850503864860603056510736437328919577083145;

    uint256 constant IC15x = 19120442403023260263194744419012497559148169731870361710680906533455659899990;
    uint256 constant IC15y = 16565293151963357015739794667146450468279039337181681733939742357303529922159;

    uint256 constant IC16x = 18160875564461956779794071836815029474222907530022782076628235815616169408618;
    uint256 constant IC16y = 11998693678811777316633556852929091623912912312878751739228443470785876534120;

    uint256 constant IC17x = 15144491965602843451760082458508295954742843012950567866814247474880996612805;
    uint256 constant IC17y = 3951500297822832000658755396408345709165100559525407029529208666249416857053;

    uint256 constant IC18x = 18385238706747803602797870658908670130964189547975435146487445635680822449146;
    uint256 constant IC18y = 15737157501731690359377095170955167671964393394447125770257518237890990316249;

    uint256 constant IC19x = 5496218165947638128256961856347866264729278682179296003832819965428417441840;
    uint256 constant IC19y = 7603326166522169461946750299302037075436505009858539763974516358779071704867;

    uint256 constant IC20x = 17793283436432651782087867362308194097910545572434115224797931332621291641268;
    uint256 constant IC20y = 8550111420054856322281682216352677821057678384150030965053576144207772655032;

    uint256 constant IC21x = 18733896412660262267046375033455105957133193136956495741228364538321866990002;
    uint256 constant IC21y = 2100895507520093699619332821038104764612589536586892063038166687502896200998;

    uint256 constant IC22x = 8059537714616513689722686454022712018746293068688616219208412671813369483336;
    uint256 constant IC22y = 20822227818337109931128962441101129860087179374304820713856168359465237822230;

    uint256 constant IC23x = 6537900621461209696711530559991685793443589502561419955402125184534967712501;
    uint256 constant IC23y = 3803450484263449400357451261189489927198401709961097705676495276448713166146;

    uint256 constant IC24x = 4592680127626707599673303267704909641515314401323558139184168585800865826238;
    uint256 constant IC24y = 19395323311258422630917454205873752315994043853090057684955714606093640625943;

    uint256 constant IC25x = 6882040585762977095036984510125114143889435854461437194592449572449677955419;
    uint256 constant IC25y = 9854600624712883456502782338332044745268170634079328303993655678303905676137;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
